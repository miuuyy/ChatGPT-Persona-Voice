"use strict";

const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { probeNativeHelper, terminateChild, waitForExit } = require("./native-helper.cjs");
const { NativeFrameParser, encodeAudioFrame, writeFrame } = require("./native-protocol.cjs");

const PROBE_CACHE_MS = 5_000;

class MacAudioOutput {
  constructor({
    helperPath,
    platform = process.platform,
    exists = fs.existsSync,
    spawnProcess = spawn,
    probeHelper = probeNativeHelper,
    terminateProcess = terminateChild,
    waitForChildExit = waitForExit,
    logger = null,
    clock = () => Date.now(),
    startupPrebufferMs = 500,
    startupDelayMs = 0,
  }) {
    if (!Number.isInteger(startupPrebufferMs) || startupPrebufferMs < 200 || startupPrebufferMs > 1000 || startupPrebufferMs % 20) {
      throw new Error("Core Audio prebuffer must be a multiple of 20 ms between 200 and 1000 ms");
    }
    this.startupPrebufferMs = startupPrebufferMs;
    if (!Number.isInteger(startupDelayMs) || startupDelayMs < 0 || startupDelayMs > 500) {
      throw new Error("Core Audio startup delay must be between 0 and 500 ms");
    }
    this.startupDelayMs = startupDelayMs;
    this.helperPath = helperPath;
    this.platform = platform;
    this.exists = exists;
    this.spawnProcess = spawnProcess;
    this.probeHelper = probeHelper;
    this.terminateProcess = terminateProcess;
    this.waitForChildExit = waitForChildExit;
    this.logger = logger;
    this.clock = clock;
    this.cachedProbes = new Map();
    this.probesInFlight = new Map();
  }

  async probe(deviceUid = null) {
    if (this.platform !== "darwin") {
      return { ready: false, code: "macos_only", detail: "The native Core Audio sink is available only on macOS" };
    }
    if (!this.helperPath || !this.exists(this.helperPath)) {
      return { ready: false, code: "macos_output_helper_missing", detail: "The macOS output helper is not built" };
    }
    if (deviceUid !== null && (typeof deviceUid !== "string" || !deviceUid.trim() || deviceUid.length > 4_096)) {
      return { ready: false, code: "macos_output_device_invalid", detail: "The Core Audio output device UID is invalid" };
    }
    const key = deviceUid || "default";
    const now = this.clock();
    const cached = this.cachedProbes.get(key);
    if (cached && now - cached.at < PROBE_CACHE_MS) return cached.value;
    if (this.probesInFlight.has(key)) return this.probesInFlight.get(key);
    const probe = (async () => {
      try {
        const result = await this.probeHelper(this.helperPath, "output", {
          args: ["--self-test", ...(this.startupPrebufferMs === 500 ? [] : ["--startup-prebuffer-ms", String(this.startupPrebufferMs)]),
                 ...(this.startupDelayMs === 0 ? [] : ["--startup-delay-ms", String(this.startupDelayMs)]),
                 ...(deviceUid ? ["--device-uid", deviceUid] : [])],
        });
        if (result.supportsJitterBuffer !== true || result.startsWhenQueueFull !== true ||
            result.startupPrebufferMs !== this.startupPrebufferMs || result.queueCapacityFrames < Math.max(45, Math.ceil(this.startupPrebufferMs / 20)) ||
            result.startupDelayMs !== this.startupDelayMs ||
            typeof result.deviceUid !== "string" || !result.deviceUid ||
            typeof result.deviceName !== "string" || !result.deviceName ||
            !Array.isArray(result.memberDeviceUids) ||
            result.memberDeviceUids.some((uid) => typeof uid !== "string" || !uid) ||
            typeof result.memberDeviceUidsVerified !== "boolean" ||
            typeof result.isAggregateDevice !== "boolean" ||
            (deviceUid && (result.deviceUid !== deviceUid || result.usesDefaultDevice !== false))) {
          throw new Error("Output self-test did not declare its bounded jitter buffer");
        }
        return {
          ready: true,
          code: "ready",
          detail: deviceUid
            ? `${result.deviceName || deviceUid} passed the Core Audio output self-test`
            : "Core Audio output helper and default device passed self-test",
          deviceUid: result.deviceUid,
          deviceName: result.deviceName,
          usesDefaultDevice: result.usesDefaultDevice === true,
          memberDeviceUids: [...result.memberDeviceUids],
          memberDeviceUidsVerified: result.memberDeviceUidsVerified,
          isAggregateDevice: result.isAggregateDevice,
        };
      } catch (error) {
        return {
          ready: false,
          code: "macos_output_helper_failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    })();
    this.probesInFlight.set(key, probe);
    try {
      const value = await probe;
      this.cachedProbes.set(key, { at: this.clock(), value });
      return value;
    } finally {
      if (this.probesInFlight.get(key) === probe) this.probesInFlight.delete(key);
    }
  }

  async prepare(config, format, onError) {
    const deviceUid = config?.outputDeviceUid ?? null;
    const readiness = await this.probe(deviceUid);
    if (!readiness.ready) throw new Error(readiness.detail);
    if (!format || format.sampleFormat !== "f32le" ||
        !Number.isInteger(format.sampleRate) || format.sampleRate < 8_000 || format.sampleRate > 192_000 ||
        !Number.isInteger(format.channels) || format.channels < 1 || format.channels > 2) {
      throw new Error("The voice engine must declare an f32le output format with one or two channels");
    }
    if (typeof onError !== "function") throw new Error("Output error handler is required");

    const childArguments = [
      "--sample-rate", String(format.sampleRate),
      "--channels", String(format.channels),
      ...(this.startupPrebufferMs === 500 ? [] : ["--startup-prebuffer-ms", String(this.startupPrebufferMs)]),
      ...(this.startupDelayMs === 0 ? [] : ["--startup-delay-ms", String(this.startupDelayMs)]),
      ...(deviceUid ? ["--device-uid", deviceUid] : []),
    ];
    const child = this.spawnProcess(this.helperPath, childArguments, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let ready = false;
    let closing = false;
    let closed = false;
    let closeInFlight = null;
    let stderr = "";
    let reported = false;
    let faulted = false;
    let writtenFrames = 0;
    let readyMessage = null;
    const report = (error) => {
      if (closing || reported) return;
      reported = true;
      faulted = true;
      onError(error instanceof Error ? error : new Error(String(error)));
    };
    const closeSession = async () => {
      if (closed) return;
      if (closeInFlight) return closeInFlight;
      closing = true;
      closeInFlight = (async () => {
        if (child.exitCode === null && child.signalCode === null && !child.stdin.destroyed) {
          child.stdin.end();
        }
        try { await this.waitForChildExit(child, 6_000); }
        catch {
          child.stdin.destroy();
          await this.terminateProcess(child);
        }
        if (child.exitCode !== 0 && child.signalCode === null) {
          this.logger?.warn?.("native.output_closed_after_error", {
            helperPid: Number.isInteger(child.pid) ? child.pid : null,
            code: child.exitCode,
            message: stderr.trim() || null,
          });
        }
        closed = true;
      })();
      try {
        return await closeInFlight;
      } finally {
        closeInFlight = null;
      }
    };
    const session = {
      format: { ...format },
      get deviceUid() { return readyMessage?.deviceUid ?? null; },
      get deviceName() { return readyMessage?.deviceName ?? null; },
      get usesDefaultDevice() { return readyMessage?.usesDefaultDevice === true; },
      get memberDeviceUids() { return [...(readyMessage?.memberDeviceUids || [])]; },
      get memberDeviceUidsVerified() { return readyMessage?.memberDeviceUidsVerified === true; },
      get isAggregateDevice() { return readyMessage?.isAggregateDevice === true; },
      write: async (frame) => {
        if (!ready || faulted || closing || child.exitCode !== null || child.signalCode !== null) {
          throw new Error("Core Audio output is closed");
        }
        if (frame.sampleRate !== format.sampleRate || frame.channels !== format.channels ||
            (frame.sampleFormat ?? "f32le") !== format.sampleFormat) {
          throw new Error("Converted frame does not match the prepared Core Audio output format");
        }
        await writeFrame(child.stdin, encodeAudioFrame(frame));
        writtenFrames += 1;
        if (writtenFrames === 1) {
          this.logger?.info("native.output_first_frame", {
            helperPid: Number.isInteger(child.pid) ? child.pid : null,
            sequence: frame.sequence,
            samplesPerChannel: frame.samplesPerChannel,
          });
        }
      },
      close: closeSession,
    };

    await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => finish(new Error("Core Audio output did not become ready")), 5_000);
      timeout.unref?.();
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(value);
      };
      const parser = new NativeFrameParser((message) => {
        if (message.type === "error") {
          const error = new Error(message.message || "Native output failed");
          error.code = message.code || "native_output_failed";
          if (!settled) finish(error);
          else report(error);
        } else if (message.type === "ready") {
          if (ready) {
            report(new Error("Output helper emitted readiness more than once"));
            return;
          }
          if (message.helper !== "output" || message.protocolVersion !== 1 ||
              message.sampleRate !== format.sampleRate ||
              message.channels !== format.channels || message.sampleFormat !== "f32le" ||
              message.supportsJitterBuffer !== true || message.startsWhenQueueFull !== true ||
              message.startupPrebufferMs !== this.startupPrebufferMs ||
              message.startupDelayMs !== this.startupDelayMs ||
              message.queueCapacityFrames < Math.max(45, Math.ceil(this.startupPrebufferMs / 20)) ||
              typeof message.deviceUid !== "string" || !message.deviceUid ||
              typeof message.deviceName !== "string" || !message.deviceName ||
              !Array.isArray(message.memberDeviceUids) ||
              message.memberDeviceUids.some((uid) => typeof uid !== "string" || !uid) ||
              typeof message.memberDeviceUidsVerified !== "boolean" ||
              typeof message.isAggregateDevice !== "boolean" ||
              (deviceUid && (message.deviceUid !== deviceUid || message.usesDefaultDevice !== false))) {
            finish(new Error("Output helper readiness does not match the engine output format"));
            return;
          }
          ready = true;
          readyMessage = message;
          this.logger?.info("native.output_ready", {
            helperPid: Number.isInteger(child.pid) ? child.pid : null,
            sampleRate: format.sampleRate,
            channels: format.channels,
            deviceUid: message.deviceUid ?? null,
            deviceName: message.deviceName ?? null,
          });
          finish(null, message);
        } else if (message.type === "status") {
          if (!ready || message.helper !== "output" ||
              !["running", "rebuffering"].includes(message.state) ||
              !Number.isInteger(message.underruns) || message.underruns < 0) {
            const error = new Error("Output helper emitted an invalid jitter-buffer status");
            if (!settled) finish(error);
            else report(error);
            return;
          }
          const event = message.state === "rebuffering"
            ? "native.output_rebuffering"
            : "native.output_buffered";
          const level = message.state === "rebuffering" ? "warn" : "info";
          this.logger?.[level]?.(event, {
            reason: message.reason ?? null,
            underruns: message.underruns,
            bufferedMs: message.bufferedMs ?? null,
            targetBufferedMs: message.targetBufferedMs ?? null,
          });
        } else {
          const error = new Error("Output helper emitted an unexpected audio frame");
          if (!settled) finish(error);
          else report(error);
        }
      });
      child.stdout.on("data", (chunk) => {
        try { parser.push(chunk); }
        catch (error) {
          if (!settled) finish(error);
          else report(error);
        }
      });
      child.stderr.on("data", (chunk) => {
        const value = chunk.toString("utf8");
        stderr += value;
        this.logger?.debug("native.output_stderr", { message: value.trim() });
      });
      child.stdin.on("error", (error) => {
        if (!settled) finish(error);
        else report(error);
      });
      child.once("error", (error) => {
        if (!settled) finish(error);
        else report(error);
      });
      child.once("exit", (code, signal) => {
        if (!settled) {
          finish(new Error(
            stderr.trim() || `Output helper exited before readiness (code=${String(code)}, signal=${String(signal)})`,
          ));
        } else if (!closing && ready) {
          report(new Error(`Core Audio output exited unexpectedly (code=${String(code)}, signal=${String(signal)})`));
        }
      });
    }).catch(async (error) => {
      closing = true;
      child.stdin.destroy();
      try {
        await this.terminateProcess(child);
        closed = true;
      } catch (cleanupError) {
        const failure = new Error(
          `Core Audio output startup failed (${error instanceof Error ? error.message : String(error)}) and ` +
          `helper termination could not be proven: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
        failure.outputSession = session;
        throw failure;
      }
      throw error;
    });

    return session;
  }
}

module.exports = { MacAudioOutput, PROBE_CACHE_MS };
