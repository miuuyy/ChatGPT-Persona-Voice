"use strict";

const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { probeNativeHelper, terminateChild, waitForExit } = require("./native-helper.cjs");
const { NativeFrameParser, encodeAudioFrame, writeFrame } = require("./native-protocol.cjs");

const PROBE_CACHE_MS = 5_000;
const OUTPUT_BOUNDS = Object.freeze({
  converted: Object.freeze({ startupPrebufferMs: 500, queueCapacityMs: 1_500 }),
  passthrough: Object.freeze({ startupPrebufferMs: 40, queueCapacityMs: 250 }),
});

class WindowsAudioOutput {
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
  }) {
    this.helperPath = helperPath;
    this.platform = platform;
    this.exists = exists;
    this.spawnProcess = spawnProcess;
    this.probeHelper = probeHelper;
    this.terminateProcess = terminateProcess;
    this.waitForChildExit = waitForChildExit;
    this.logger = logger;
    this.clock = clock;
    this.cachedProbe = null;
    this.probeInFlight = null;
  }

  async probe() {
    if (this.platform !== "win32") {
      return { ready: false, code: "windows_only", detail: "The WASAPI sink is available only on Windows" };
    }
    if (!this.helperPath || !this.exists(this.helperPath)) {
      return { ready: false, code: "windows_output_helper_missing", detail: "The Windows output helper is not built" };
    }
    const now = this.clock();
    if (this.cachedProbe && now - this.cachedProbe.at < PROBE_CACHE_MS) return this.cachedProbe.value;
    if (this.probeInFlight) return this.probeInFlight;
    const probe = (async () => {
      try {
        const result = await this.probeHelper(this.helperPath, "output");
        if (result.backend !== "wasapi-shared-render" ||
            result.supportsJitterBuffer !== true ||
            result.startsWhenQueueFull !== true ||
            result.mode !== "converted" ||
            result.startupPrebufferMs !== OUTPUT_BOUNDS.converted.startupPrebufferMs ||
            result.queueCapacityMs !== OUTPUT_BOUNDS.converted.queueCapacityMs ||
            result.supportsPassthrough !== true ||
            result.passthroughSilenceOnInputGap !== true ||
            result.passthroughStartupPrebufferMs !== OUTPUT_BOUNDS.passthrough.startupPrebufferMs ||
            result.passthroughQueueCapacityMs !== OUTPUT_BOUNDS.passthrough.queueCapacityMs ||
            typeof result.deviceId !== "string" || !result.deviceId ||
            typeof result.deviceName !== "string" || !result.deviceName ||
            result.suppressionSink !== false ||
            result.usesDefaultDevice !== true) {
          throw new Error("Windows output self-test did not prove the bounded WASAPI contract");
        }
        return {
          ready: true,
          code: "ready",
          detail: `${result.deviceName} passed the bounded WASAPI output self-test`,
          deviceId: result.deviceId,
          deviceName: result.deviceName,
        };
      } catch (error) {
        return {
          ready: false,
          code: "windows_output_helper_failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    })();
    this.probeInFlight = probe;
    try {
      const value = await probe;
      this.cachedProbe = { at: this.clock(), value };
      return value;
    } finally {
      if (this.probeInFlight === probe) this.probeInFlight = null;
    }
  }

  async prepare(_config, format, onError) {
    const mode = _config?.outputMode ?? "converted";
    const bounds = OUTPUT_BOUNDS[mode];
    if (!bounds) throw new Error(`Unsupported Windows output mode: ${String(mode)}`);
    if (!format || !Number.isInteger(format.sampleRate) ||
        !Number.isInteger(format.channels) || format.sampleFormat !== "f32le") {
      throw new Error("Windows output requires an explicit f32le format");
    }
    if (typeof onError !== "function") throw new Error("Windows output error handler is required");
    const readiness = await this.probe();
    if (!readiness.ready) throw new Error(readiness.detail);

    const child = this.spawnProcess(this.helperPath, [
      "--sample-rate", String(format.sampleRate),
      "--channels", String(format.channels),
      "--mode", mode,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let ready = null;
    let closing = false;
    let closed = false;
    let reported = false;
    let stderr = "";
    const report = (error) => {
      if (closing || reported) return;
      reported = true;
      onError(error instanceof Error ? error : new Error(String(error)));
    };

    const session = {
      format: { ...format },
      mode,
      write: async (frame) => {
        if (!ready || closing || closed) throw new Error("The Windows output session is not writable");
        if (frame.sampleRate !== format.sampleRate || frame.channels !== format.channels ||
            frame.sampleFormat !== format.sampleFormat) {
          throw new Error("The converted frame does not match the prepared Windows output format");
        }
        await writeFrame(child.stdin, encodeAudioFrame(frame));
      },
      close: async () => {
        if (closed) return;
        if (closing) {
          await this.waitForChildExit(child, 5_000);
          closed = true;
          return;
        }
        closing = true;
        child.stdin.end();
        try {
          const exit = await this.waitForChildExit(child, 8_000);
          if (exit.code !== 0 || exit.signal !== null) {
            throw new Error(
              stderr.trim() || `Windows output exited during close (code=${String(exit.code)}, signal=${String(exit.signal)})`,
            );
          }
          closed = true;
        } catch (error) {
          if (child.exitCode === null && child.signalCode === null) await this.terminateProcess(child);
          throw error;
        }
      },
    };

    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => finish(new Error("Windows output did not become ready within 10 seconds")), 10_000);
        timeout.unref?.();
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (error) reject(error);
          else resolve();
        };
        const parser = new NativeFrameParser((message) => {
          if (message.type === "ready") {
            if (ready || message.helper !== "output" || message.backend !== "wasapi-shared-render" ||
                message.sampleRate !== format.sampleRate || message.channels !== format.channels ||
                message.sampleFormat !== format.sampleFormat ||
                message.supportsJitterBuffer !== true || message.startsWhenQueueFull !== true ||
                message.mode !== mode ||
                message.startupPrebufferMs !== bounds.startupPrebufferMs ||
                message.queueCapacityMs !== bounds.queueCapacityMs ||
                message.supportsPassthrough !== true ||
                message.passthroughSilenceOnInputGap !== true ||
                message.passthroughStartupPrebufferMs !== OUTPUT_BOUNDS.passthrough.startupPrebufferMs ||
                message.passthroughQueueCapacityMs !== OUTPUT_BOUNDS.passthrough.queueCapacityMs ||
                typeof message.deviceId !== "string" || !message.deviceId ||
                typeof message.deviceName !== "string" || !message.deviceName ||
                message.suppressionSink !== false) {
              finish(new Error("Windows output emitted invalid or unsafe readiness"));
              return;
            }
            ready = message;
            this.logger?.info("native.windows_output_ready", {
              helperPid: Number.isInteger(child.pid) ? child.pid : null,
              deviceId: message.deviceId,
              deviceName: message.deviceName,
              bufferFrames: message.bufferFrames,
            });
            finish();
          } else if (message.type === "error") {
            const error = new Error(message.message || "Windows output failed");
            error.code = message.code || "windows_output_failed";
            if (!settled) finish(error);
            else report(error);
          } else if (message.type === "status") {
            if (message.helper !== "output" || message.state !== "running") {
              const error = new Error("Windows output emitted an invalid lifecycle status");
              if (!settled) finish(error);
              else report(error);
            }
          } else {
            const error = new Error("Windows output emitted an unexpected CPV1 frame");
            if (!settled) finish(error);
            else report(error);
          }
        });
        child.stdout.on("data", (chunk) => {
          try { parser.push(chunk); }
          catch (error) { if (!settled) finish(error); else report(error); }
        });
        child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
        child.once("error", (error) => { if (!settled) finish(error); else report(error); });
        child.once("exit", (code, signal) => {
          try { parser.finish(); }
          catch (error) { if (!settled) finish(error); else report(error); return; }
          if (!settled) {
            finish(new Error(stderr.trim() ||
              `Windows output exited before readiness (code=${String(code)}, signal=${String(signal)})`));
          } else if (!closing && ready) {
            report(new Error(stderr.trim() ||
              `Windows output exited unexpectedly (code=${String(code)}, signal=${String(signal)})`));
          }
        });
      });
      return session;
    } catch (error) {
      closing = true;
      child.stdin.destroy();
      try { await this.terminateProcess(child); }
      catch (cleanupError) {
        const failure = new Error(
          `Windows output startup failed (${error instanceof Error ? error.message : String(error)}) and ` +
          `termination could not be proven: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
        failure.outputSession = session;
        throw failure;
      }
      throw error;
    }
  }
}

module.exports = { OUTPUT_BOUNDS, PROBE_CACHE_MS, WindowsAudioOutput };
