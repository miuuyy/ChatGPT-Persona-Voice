"use strict";

const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { NativeFrameParser } = require("./native-protocol.cjs");
const { probeNativeHelper, terminateChild } = require("./native-helper.cjs");
const {
  resolveDefaultVoiceProcessTree,
  resolveSelectedProcessTree,
} = require("./source-discovery.cjs");
const { targetAppLabel } = require("./target-apps.cjs");

const PROBE_CACHE_MS = 5_000;

class MacProcessRoute {
  constructor({
    helperPath,
    platform = process.platform,
    exists = fs.existsSync,
    spawnProcess = spawn,
    processResolver = resolveSelectedProcessTree,
    defaultProcessResolver = resolveDefaultVoiceProcessTree,
    probeHelper = probeNativeHelper,
    terminateProcess = terminateChild,
    logger = null,
    clock = () => Date.now(),
  }) {
    this.helperPath = helperPath;
    this.platform = platform;
    this.exists = exists;
    this.spawnProcess = spawnProcess;
    this.processResolver = processResolver;
    this.defaultProcessResolver = defaultProcessResolver;
    this.probeHelper = probeHelper;
    this.terminateProcess = terminateProcess;
    this.logger = logger;
    this.clock = clock;
    this.child = null;
    this.ready = null;
    this.routeState = null;
    this.frameHandler = null;
    this.errorHandler = null;
    this.pendingStreamError = null;
    this.routeErrorHandler = null;
    this.routeStatusHandler = null;
    this.releaseFailure = null;
    this.unresolvedReleaseError = null;
    this.suppressionUncertain = false;
    this.releasePromise = null;
    this.closing = false;
    this.expectedSequence = null;
    this.sessionFrameCount = 0;
    this.audibleFrameLogged = false;
    this.cachedProbe = null;
    this.probeInFlight = null;
  }

  isSuppressed() {
    return Boolean(this.unresolvedReleaseError?.suppressionHeld === true || this.suppressionUncertain ||
      (this.child && this.routeState === "engaged" &&
      this.child.exitCode === null && this.child.signalCode === null));
  }

  isArmed() {
    return Boolean(this.child && this.ready?.armed === true &&
      this.child.exitCode === null && this.child.signalCode === null);
  }

  async helperReadiness() {
    if (this.platform !== "darwin") {
      return { ready: false, code: "macos_only", detail: "Muted process taps are available only on macOS" };
    }
    if (!this.helperPath || !this.exists(this.helperPath)) {
      return { ready: false, code: "macos_capture_helper_missing", detail: "The macOS capture helper is not built" };
    }
    const now = this.clock();
    if (this.cachedProbe && now - this.cachedProbe.at < PROBE_CACHE_MS) return this.cachedProbe.value;
    if (this.probeInFlight) return this.probeInFlight;
    const probe = (async () => {
      try {
        const result = await this.probeHelper(this.helperPath, "capture");
        if (!Number.isInteger(result.sampleRate) || !Number.isInteger(result.channels) ||
            result.sampleFormat !== "f32le" || result.supportsArming !== true ||
            result.supportsDeferredTap !== true || result.supportsCaptureProof !== true) {
          throw new Error(
            "Capture self-test did not declare deferred-tap arming with PCM proof",
          );
        }
        return {
          ready: true,
          code: "ready",
          detail: "Deferred Core Audio capture helper passed its duplex-lifecycle self-test",
          sourceFormat: {
            sampleRate: result.sampleRate,
            channels: result.channels,
            sampleFormat: result.sampleFormat,
          },
        };
      } catch (error) {
        return {
          ready: false,
          code: "macos_capture_helper_failed",
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

  async describe(settings) {
    const readiness = await this.probe(settings);
    if (!readiness.ready) throw new Error(readiness.detail);
    const helper = await this.helperReadiness();
    if (!helper.sourceFormat) throw new Error("Muted capture source format is unavailable");
    return { ...helper.sourceFormat };
  }

  resolveProcesses(settings) {
    return settings?.sourceId
      ? this.processResolver({ sourceId: settings.sourceId, platform: this.platform })
      : this.defaultProcessResolver({
          platform: this.platform,
          targetApp: settings?.targetApp,
        });
  }

  async probe(settings) {
    const helper = await this.helperReadiness();
    if (!helper.ready) return helper;
    try {
      const processes = await this.resolveProcesses(settings);
      if (processes.pids.length === 0) {
        return {
          ready: false,
          code: "desktop_source_not_running",
          detail: settings?.sourceName
            ? `${settings.sourceName} is not currently running`
            : `Start ${targetAppLabel(settings?.targetApp)} before starting Persona Voice`,
        };
      }
      return {
        ready: true,
        code: "ready",
          detail: settings?.sourceName
            ? `${settings.sourceName} process tree is ready for deferred muted capture`
            : `${targetAppLabel(settings?.targetApp)} process tree is ready for deferred muted capture`,
      };
    } catch (error) {
      return {
        ready: false,
        code: "desktop_source_discovery_failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async acquire(settings, onRouteError, onRouteStatus, { signal } = {}) {
    if (this.child) throw new Error("A macOS process route is already acquired");
    if (this.unresolvedReleaseError) throw this.unresolvedReleaseError;
    if (typeof onRouteError !== "function") {
      throw new Error("A route-liveness error handler is required");
    }
    if (typeof onRouteStatus !== "function") {
      throw new Error("A route-lifecycle status handler is required");
    }
    if (signal?.aborted) throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Muted-route acquisition was cancelled");
    const readiness = await this.probe(settings);
    if (!readiness.ready) throw new Error(readiness.detail);
    const processes = await this.resolveProcesses(settings);
    if (signal?.aborted) throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Muted-route acquisition was cancelled");
    if (processes.pids.length === 0) {
      throw new Error(`${settings.sourceName || targetAppLabel(settings?.targetApp)} stopped before capture began`);
    }

    if (!Array.isArray(processes.rootPids) || processes.rootPids.length === 0) {
      throw new Error(`${settings.sourceName || targetAppLabel(settings?.targetApp)} application root stopped before capture began`);
    }
    const args = processes.rootPids.flatMap((pid) => ["--root-pid", String(pid)]);
    const child = this.spawnProcess(this.helperPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.logger?.info("native.capture_spawned", {
      helperPid: Number.isInteger(child.pid) ? child.pid : null,
      targetRootProcessCount: processes.rootPids.length,
    });
    this.child = child;
    this.routeErrorHandler = onRouteError;
    this.routeStatusHandler = onRouteStatus;
    this.releaseFailure = null;
    this.suppressionUncertain = false;
    this.closing = false;
    this.ready = null;
    this.routeState = null;
    this.expectedSequence = null;
    this.pendingStreamError = null;

    let acquisitionPending = true;
    let acquisitionTerminalError = null;
    const rememberAcquisitionTerminal = (error, suppressionHeld, permanentlyUnproven = false) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      normalized.suppressionHeld = suppressionHeld;
      acquisitionTerminalError ||= normalized;
      this.frameHandler = null;
      this.errorHandler = null;
      if (suppressionHeld) {
        this.suppressionUncertain = true;
        if (permanentlyUnproven) this.unresolvedReleaseError ||= normalized;
      } else {
        this.ready = null;
        this.routeState = null;
        this.suppressionUncertain = false;
      }
    };

    await new Promise((resolve, reject) => {
      let settled = false;
      let stderr = "";
      let abortHandler = null;
      const timeout = setTimeout(() => finish(new Error(
        "Muted Core Audio capture did not become ready; check the macOS Audio Capture permission prompt",
      )), 30_000);
      timeout.unref?.();
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (abortHandler) signal?.removeEventListener("abort", abortHandler);
        if (error) reject(error);
        else resolve(value);
      };
      abortHandler = () => finish(signal.reason instanceof Error
        ? signal.reason
        : new Error("Muted-route acquisition was cancelled"));
      signal?.addEventListener("abort", abortHandler, { once: true });
      if (signal?.aborted) abortHandler();
      const parser = new NativeFrameParser((message) => {
        if (message.type === "ready") {
          if (this.ready) {
            const error = new Error("Capture helper emitted readiness more than once");
            if (acquisitionPending) rememberAcquisitionTerminal(error, true);
            else this.reportRouteProtocolError(error);
            return;
          }
          if (message.helper !== "capture" || message.protocolVersion !== 1 ||
              message.supportsArming !== true || message.supportsDeferredTap !== true ||
              message.supportsCaptureProof !== true ||
              message.armed !== true || message.tapActive !== false ||
              message.activationSignal !== "duplex_process_io" ||
              message.state !== "armed" || message.originalSuppressed !== false ||
              message.sampleFormat !== "f32le") {
            const error = new Error("Capture helper did not prove tap-free duplex observer readiness");
            error.suppressionHeld = true;
            this.suppressionUncertain = true;
            finish(error);
            return;
          }
          this.ready = message;
          this.routeState = "armed";
          this.logger?.info("native.capture_observer_ready", {
            helperPid: Number.isInteger(child.pid) ? child.pid : null,
            activationSignal: message.activationSignal,
            tapActive: message.tapActive,
          });
          finish(null, message);
          return;
        }
        if (message.type === "status") {
          if (!this.ready) {
            const error = new Error("Capture helper emitted route status before readiness");
            error.code = "native_capture_protocol_error";
            error.suppressionHeld = true;
            this.routeState = message.originalSuppressed === true ? "engaged" : this.routeState;
            this.suppressionUncertain = true;
            finish(error);
            return;
          }
          const statusError = this.handleStatus(message, !acquisitionPending);
          if (statusError && acquisitionPending) {
            rememberAcquisitionTerminal(statusError, true);
          }
          return;
        }
        if (message.type === "error") {
          const error = new Error(message.message || "Native capture failed");
          error.code = message.code || "native_capture_failed";
          if (!settled) {
            const hasTruth = typeof message.suppressionHeld === "boolean";
            error.suppressionHeld = hasTruth ? message.suppressionHeld : true;
            if (error.suppressionHeld) {
              this.suppressionUncertain = true;
              if (error.code === "route_disengage_failed") {
                this.unresolvedReleaseError ||= error;
              }
            }
            finish(error);
          }
          else if (acquisitionPending) {
            if (typeof message.suppressionHeld !== "boolean") {
              error.code = "native_capture_protocol_error";
              error.message = "Native capture error omitted its suppression state";
              rememberAcquisitionTerminal(error, true);
            } else {
              rememberAcquisitionTerminal(
                error,
                message.suppressionHeld,
                message.suppressionHeld === true && error.code === "route_disengage_failed",
              );
            }
          }
          else if (typeof message.suppressionHeld !== "boolean") {
            this.reportRouteProtocolError(new Error(
              "Native capture error omitted its suppression state",
            ));
          } else {
            error.suppressionHeld = message.suppressionHeld;
            if (message.suppressionHeld === true) this.suppressionUncertain = true;
            if (message.suppressionHeld === false) this.reportRouteLoss(error);
            else if (this.closing) this.releaseFailure ||= error;
            else if (error.code === "route_disengage_failed") this.reportUnresolvedSuppression(error);
            else this.reportStreamError(error);
          }
          return;
        }
        if (message.type === "audio") {
          if (!this.ready) {
            const error = new Error("Capture helper emitted PCM before readiness");
            error.code = "native_capture_protocol_error";
            error.suppressionHeld = true;
            this.suppressionUncertain = true;
            finish(error);
            return;
          }
          if (acquisitionPending && !this.isSuppressed()) {
            const error = new Error("Native capture emitted PCM before proving original suppression");
            error.code = "native_capture_protocol_error";
            rememberAcquisitionTerminal(error, true);
            return;
          }
          this.handleAudio(message);
        }
      });
      child.stdout.on("data", (chunk) => {
        try { parser.push(chunk); }
        catch (error) {
          if (!settled) finish(error);
          else if (acquisitionPending) rememberAcquisitionTerminal(error, true);
          else this.reportRouteProtocolError(error);
        }
      });
      child.stderr.on("data", (chunk) => {
        const value = chunk.toString("utf8");
        stderr += value;
        this.logger?.debug("native.capture_stderr", { message: value.trim() });
      });
      child.once("error", (error) => {
        if (!settled) finish(error);
        else if (acquisitionPending) {
          const normalized = error instanceof Error ? error : new Error(String(error));
          normalized.code ||= "source_helper_process_error";
          rememberAcquisitionTerminal(normalized, true);
        }
        else if (this.closing) {
          const normalized = error instanceof Error ? error : new Error(String(error));
          normalized.code ||= "source_helper_process_error";
          normalized.suppressionHeld = true;
          this.suppressionUncertain = true;
          this.logger?.error("native.capture_release_process_error", { message: normalized.message });
        } else {
          const normalized = error instanceof Error ? error : new Error(String(error));
          normalized.code ||= "source_helper_process_error";
          normalized.suppressionHeld = true;
          this.reportSuppressionUncertain(normalized);
        }
      });
      child.once("exit", (code, signal) => {
        const wasClosing = this.closing;
        const wasSuppressed = this.routeState === "engaged" || this.suppressionUncertain;
        this.logger?.info("native.capture_exited", {
          helperPid: Number.isInteger(child.pid) ? child.pid : null,
          code,
          signal,
          expected: wasClosing,
          wasSuppressed,
        });
        this.ready = null;
        this.routeState = null;
        if (!settled) {
          finish(new Error(
            stderr.trim() || `Capture helper exited before readiness (code=${String(code)}, signal=${String(signal)})`,
          ));
        } else if (wasClosing && wasSuppressed && (code !== 0 || signal !== null)) {
          const error = new Error(
            `Capture helper could not prove original-route restoration (code=${String(code)}, signal=${String(signal)})`,
          );
          error.code = "source_suppression_release_unproven";
          error.suppressionHeld = true;
          this.releaseFailure ||= error;
        } else if (!wasClosing && this.suppressionUncertain) {
          const error = new Error(
            `Capture helper exited after a process-control error without proving route restoration (code=${String(code)}, signal=${String(signal)})`,
          );
          error.code = "source_suppression_release_unproven";
          error.suppressionHeld = true;
          this.unresolvedReleaseError ||= error;
        } else if (!wasClosing) {
          const error = new Error(wasSuppressed
            ? `Capture helper exited unexpectedly; the original route is no longer suppressed (code=${String(code)}, signal=${String(signal)})`
            : `Armed capture helper exited unexpectedly (code=${String(code)}, signal=${String(signal)})`);
          error.suppressionHeld = false;
          this.reportRouteLoss(error);
        }
      });
    }).then(() => {
      if (acquisitionTerminalError) throw acquisitionTerminalError;
      if (this.child !== child || !this.isArmed() || typeof this.routeStatusHandler !== "function") {
        const error = new Error("Capture route became unavailable before acquisition completed");
        error.code = "source_route_lost_during_acquire";
        error.suppressionHeld = this.isSuppressed();
        throw error;
      }
      acquisitionPending = false;
      this.routeStatusHandler({
        type: "status",
        state: this.routeState,
        reason: "route_acquired",
        originalSuppressed: this.isSuppressed(),
      });
    }).catch(async (error) => {
      acquisitionPending = false;
      this.closing = true;
      try {
        await this.terminateProcess(child);
      } catch (terminationError) {
        this.closing = false;
        this.suppressionUncertain = true;
        const failure = new Error(
          `Muted-route acquisition failed (${error instanceof Error ? error.message : String(error)}) and ` +
          `the capture helper could not be terminated: ${terminationError instanceof Error ? terminationError.message : String(terminationError)}`,
        );
        failure.code = "source_suppression_acquire_cleanup_unproven";
        failure.suppressionHeld = true;
        failure.suppressionSession = this.createSessionGuard();
        throw failure;
      }
      if (this.child === child) this.child = null;
      const unresolved = this.unresolvedReleaseError || this.releaseFailure;
      if (unresolved) {
        unresolved.suppressionHeld = true;
        unresolved.suppressionSession = this.createSessionGuard();
        this.ready = null;
        this.routeState = null;
        this.suppressionUncertain = true;
        this.closing = false;
        throw unresolved;
      }
      this.routeErrorHandler = null;
      this.routeStatusHandler = null;
      this.releaseFailure = null;
      this.pendingStreamError = null;
      this.ready = null;
      this.routeState = null;
      this.suppressionUncertain = false;
      this.closing = false;
      throw error;
    });
    return this.createSessionGuard();
  }

  createSessionGuard() {
    const route = this;
    return {
      get armed() { return route.isArmed(); },
      get originalSuppressed() { return route.isSuppressed(); },
      get restorationUnproven() {
        return Boolean(route.unresolvedReleaseError || route.suppressionUncertain);
      },
      format: this.ready ? {
        sampleRate: this.ready.sampleRate,
        channels: this.ready.channels,
        sampleFormat: this.ready.sampleFormat,
      } : null,
      close: () => this.release(),
    };
  }

  open(_settings, onFrame, onError) {
    if (!this.isArmed()) throw new Error("Process route must be armed before capture opens");
    if (this.frameHandler) throw new Error("The process capture stream is already open");
    if (this.pendingStreamError) throw this.pendingStreamError;
    if (typeof onFrame !== "function" || typeof onError !== "function") {
      throw new Error("Capture frame and error handlers are required");
    }
    this.frameHandler = onFrame;
    this.errorHandler = onError;
    return {
      format: {
        sampleRate: this.ready.sampleRate,
        channels: this.ready.channels,
        sampleFormat: this.ready.sampleFormat,
      },
      close: async () => {
        this.frameHandler = null;
        this.errorHandler = null;
      },
    };
  }

  handleStatus(message, notify = true) {
    const valid = (message.state === "armed" && message.originalSuppressed === false) ||
      (message.state === "engaged" && message.originalSuppressed === true);
    const tapStateValid = message.tapActive === (message.state === "engaged");
    const captureProofValid = message.state === "engaged"
      ? message.captureVerified === true
      : message.captureVerified === false;
    if (!valid || !tapStateValid || !captureProofValid) {
      const error = new Error("Native capture emitted an invalid route lifecycle state");
      if (notify) this.reportRouteProtocolError(error);
      return error;
    }
    this.routeState = message.state;
    this.suppressionUncertain = false;
    this.expectedSequence = null;
    this.sessionFrameCount = 0;
    this.audibleFrameLogged = false;
    this.logger?.info("native.capture_route_changed", {
      state: message.state,
      reason: message.reason,
      tapActive: message.tapActive,
      originalSuppressed: message.originalSuppressed,
    });
    if (notify) this.routeStatusHandler?.({ ...message });
    return null;
  }

  handleAudio(message) {
    if (!this.isSuppressed()) {
      this.reportRouteProtocolError(new Error("Native capture emitted PCM before proving original suppression"));
      return;
    }
    if (!this.frameHandler) return;
    if (this.expectedSequence !== null && message.sequence !== this.expectedSequence) {
      this.reportStreamError(new Error(
        `Native capture sequence gap: expected ${this.expectedSequence}, received ${message.sequence}`,
      ));
      return;
    }
    this.expectedSequence = (message.sequence + 1) >>> 0;
    this.sessionFrameCount += 1;
    if (this.sessionFrameCount === 1) {
      this.logger?.info("native.capture_first_frame", {
        sequence: message.sequence,
        sampleRate: message.sampleRate,
        channels: message.channels,
        samplesPerChannel: message.samplesPerChannel,
      });
    }
    if (!this.audibleFrameLogged && this.frameRms(message.pcm) >= 0.0015) {
      this.audibleFrameLogged = true;
      this.logger?.info("native.capture_first_audible_frame", {
        sequence: message.sequence,
        frameCount: this.sessionFrameCount,
      });
    }
    this.frameHandler?.({
      sequence: message.sequence,
      itemId: null,
      capturedAt: Date.now(),
      sampleRate: message.sampleRate,
      channels: message.channels,
      sampleFormat: message.sampleFormat,
      samplesPerChannel: message.samplesPerChannel,
      pcm: message.pcm,
    });
  }

  frameRms(pcm) {
    if (!Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length % 4 !== 0) return 0;
    let sum = 0;
    for (let offset = 0; offset < pcm.length; offset += 4) {
      const sample = pcm.readFloatLE(offset);
      sum += sample * sample;
    }
    return Math.sqrt(sum / (pcm.length / 4));
  }

  reportStreamError(error) {
    this.frameHandler = null;
    if (!this.errorHandler) {
      this.pendingStreamError ||= error instanceof Error ? error : new Error(String(error));
      this.logger?.error("native.capture_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const handler = this.errorHandler;
    this.errorHandler = null;
    handler(error);
  }

  reportRouteLoss(error) {
    this.frameHandler = null;
    this.errorHandler = null;
    this.routeStatusHandler = null;
    this.ready = null;
    this.routeState = null;
    this.suppressionUncertain = false;
    const normalized = error instanceof Error ? error : new Error(String(error));
    normalized.code ||= "source_suppression_lost";
    normalized.suppressionHeld = false;
    if (!this.routeErrorHandler) {
      this.logger?.error("native.capture_route_lost", { message: normalized.message });
      return;
    }
    const handler = this.routeErrorHandler;
    this.routeErrorHandler = null;
    handler(normalized);
  }

  reportRouteProtocolError(error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    normalized.code ||= "native_capture_protocol_error";
    normalized.suppressionHeld = true;
    this.reportSuppressionUncertain(normalized);
  }

  reportUnresolvedSuppression(error) {
    this.frameHandler = null;
    this.errorHandler = null;
    this.routeStatusHandler = null;
    const normalized = error instanceof Error ? error : new Error(String(error));
    normalized.code ||= "route_disengage_failed";
    normalized.suppressionHeld = true;
    this.unresolvedReleaseError ||= normalized;
    if (!this.routeErrorHandler) {
      this.logger?.error("native.capture_route_restoration_unproven", { message: normalized.message });
      return;
    }
    const handler = this.routeErrorHandler;
    this.routeErrorHandler = null;
    handler(normalized);
  }

  reportSuppressionUncertain(error) {
    this.frameHandler = null;
    this.errorHandler = null;
    this.suppressionUncertain = true;
    const normalized = error instanceof Error ? error : new Error(String(error));
    normalized.code ||= "source_helper_process_error";
    normalized.suppressionHeld = true;
    if (!this.routeErrorHandler) {
      this.logger?.error("native.capture_route_state_uncertain", { message: normalized.message });
      return;
    }
    const handler = this.routeErrorHandler;
    this.routeErrorHandler = null;
    handler(normalized);
  }

  async release() {
    if (this.releasePromise) return this.releasePromise;
    const releasePromise = this.releaseOnce();
    this.releasePromise = releasePromise;
    try {
      return await releasePromise;
    } finally {
      if (this.releasePromise === releasePromise) this.releasePromise = null;
    }
  }

  async releaseOnce() {
    const unresolvedAtStart = this.unresolvedReleaseError;
    const child = this.child;
    this.frameHandler = null;
    this.errorHandler = null;
    this.expectedSequence = null;
    this.pendingStreamError = null;
    this.sessionFrameCount = 0;
    this.audibleFrameLogged = false;
    if (!child) {
      if (unresolvedAtStart) throw unresolvedAtStart;
      if (this.suppressionUncertain) {
        const error = new Error("Original-route restoration remains unproven without a capture helper handle");
        error.code = "source_suppression_release_unproven";
        error.suppressionHeld = true;
        this.unresolvedReleaseError = error;
        throw error;
      }
      this.routeErrorHandler = null;
      this.routeStatusHandler = null;
      this.ready = null;
      this.routeState = null;
      return;
    }
    const wasSuppressed = this.routeState === "engaged" || this.suppressionUncertain;
    this.releaseFailure = null;
    this.closing = true;
    this.logger?.info("native.capture_release_started", {
      helperPid: Number.isInteger(child.pid) ? child.pid : null,
      routeState: this.routeState,
    });
    try {
      await this.terminateProcess(child);
    } catch (error) {
      this.closing = false;
      throw error;
    }
    if (this.child === child) this.child = null;
    this.ready = null;
    this.routeState = null;
    this.closing = false;
    this.routeErrorHandler = null;
    this.routeStatusHandler = null;
    if (this.releaseFailure || unresolvedAtStart) {
      const failure = unresolvedAtStart || this.releaseFailure;
      this.releaseFailure = null;
      if (wasSuppressed) this.unresolvedReleaseError = failure;
      this.logger?.error("native.capture_release_unproven", { message: failure.message });
      throw failure;
    }
    this.suppressionUncertain = false;
    this.logger?.info("native.capture_release_completed", {
      helperPid: Number.isInteger(child.pid) ? child.pid : null,
    });
  }
}

module.exports = { MacProcessRoute, PROBE_CACHE_MS };
