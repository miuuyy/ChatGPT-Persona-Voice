"use strict";

const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { NativeFrameParser } = require("./native-protocol.cjs");
const { probeNativeHelper, terminateChild, waitForExit } = require("./native-helper.cjs");
const {
  resolveDefaultVoiceProcessTree,
  resolveSelectedProcessTree,
} = require("./source-discovery.cjs");

const PROBE_CACHE_MS = 5_000;
const WINDOWS_PROCESS_LOOPBACK_MINIMUM_BUILD = 20_348;

class WindowsProcessRoute {
  constructor({
    captureHelperPath,
    routeHelperPath,
    platform = process.platform,
    exists = fs.existsSync,
    spawnProcess = spawn,
    processResolver = resolveSelectedProcessTree,
    defaultProcessResolver = resolveDefaultVoiceProcessTree,
    probeHelper = probeNativeHelper,
    terminateProcess = terminateChild,
    waitForChildExit = waitForExit,
    logger = null,
    clock = () => Date.now(),
  }) {
    this.captureHelperPath = captureHelperPath;
    this.routeHelperPath = routeHelperPath;
    this.platform = platform;
    this.exists = exists;
    this.spawnProcess = spawnProcess;
    this.processResolver = processResolver;
    this.defaultProcessResolver = defaultProcessResolver;
    this.probeHelper = probeHelper;
    this.terminateProcess = terminateProcess;
    this.waitForChildExit = waitForChildExit;
    this.logger = logger;
    this.clock = clock;
    this.captureChild = null;
    this.routeChild = null;
    this.captureReady = null;
    this.routeReady = null;
    this.routeState = null;
    this.frameHandler = null;
    this.streamErrorHandler = null;
    this.routeErrorHandler = null;
    this.routeStatusHandler = null;
    this.expectedSequence = null;
    this.suppressionUncertain = false;
    this.releaseFailure = null;
    this.releasePromise = null;
    this.closing = false;
    this.cachedProbe = null;
    this.probeInFlight = null;
    this.processProbeInFlight = new Map();
  }

  isArmed() {
    return Boolean(this.captureChild && this.routeChild && this.captureReady && this.routeReady?.armed === true &&
      this.captureChild.exitCode === null && this.captureChild.signalCode === null &&
      this.routeChild.exitCode === null && this.routeChild.signalCode === null);
  }

  childIsLive(child) {
    return Boolean(child && child.exitCode === null && child.signalCode === null);
  }

  async stopRouteVerifier(child) {
    if (!this.childIsLive(child)) return;
    if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) {
      child.stdin.end("q");
    }
    try {
      await this.waitForChildExit(child, 5_000);
    } catch (gracefulError) {
      if (!this.childIsLive(child)) return;
      try {
        await this.terminateProcess(child);
      } catch (terminationError) {
        if (this.childIsLive(child)) {
          throw new Error(
            `graceful stop failed (${gracefulError instanceof Error ? gracefulError.message : String(gracefulError)}); ` +
            `termination failed (${terminationError instanceof Error ? terminationError.message : String(terminationError)})`,
          );
        }
      }
    }
    if (this.childIsLive(child)) {
      throw new Error("Windows route shutdown returned without process-exit proof");
    }
  }

  isSuppressed() {
    return Boolean(this.suppressionUncertain || (this.isArmed() && this.routeState === "engaged"));
  }

  async helperReadiness() {
    if (this.platform !== "win32") {
      return { ready: false, code: "windows_only", detail: "WASAPI process routing is available only on Windows" };
    }
    if (!this.captureHelperPath || !this.exists(this.captureHelperPath)) {
      return { ready: false, code: "windows_capture_helper_missing", detail: "The Windows process-loopback helper is not built" };
    }
    if (!this.routeHelperPath || !this.exists(this.routeHelperPath)) {
      return { ready: false, code: "windows_route_helper_missing", detail: "The Windows virtual-endpoint verifier is not built" };
    }
    const now = this.clock();
    if (this.cachedProbe && now - this.cachedProbe.at < PROBE_CACHE_MS) return this.cachedProbe.value;
    if (this.probeInFlight) return this.probeInFlight;
    const probe = (async () => {
      try {
        const [capture, route] = await Promise.all([
          this.probeHelper(this.captureHelperPath, "capture"),
          this.probeHelper(this.routeHelperPath, "route"),
        ]);
        if (capture.backend !== "wasapi-process-loopback" ||
            capture.minimumWindowsBuild !== WINDOWS_PROCESS_LOOPBACK_MINIMUM_BUILD ||
            capture.windowsBuild < WINDOWS_PROCESS_LOOPBACK_MINIMUM_BUILD ||
            capture.sampleRate !== 48_000 || capture.channels !== 2 ||
            capture.sampleFormat !== "f32le" ||
            capture.supportsProcessTreeCapture !== true ||
            capture.supportsCaptureProof !== true ||
            capture.supportsSuppression !== false ||
            capture.suppressionBoundary !== "owned-virtual-endpoint-required") {
          throw new Error("Windows capture self-test did not prove the process-loopback contract");
        }
        if (route.backend !== "windows-virtual-endpoint-verifier" ||
            route.routeMutation !== false ||
            route.manualAssignmentRequired !== true ||
            route.restoreRequired !== true ||
            route.restoreMechanism !== "manual-volume-mixer" ||
            route.standbyPassthroughRequired !== true ||
            route.supportsCurrentSessionMembershipProof !== true ||
            route.supportsEventDrivenMonitoring !== true ||
            route.notificationGuaranteesPreAudio !== false ||
            route.proofScope !== "current-live-sessions" ||
            !Number.isInteger(route.virtualCableCount) ||
            route.virtualCableInstalled !== true ||
            route.virtualCableCount !== 1 ||
            route.sinkName !== "CABLE Input (VB-Audio Virtual Cable)" ||
            route.sinkIdentity !== "vb-audio-vb-cable-input-v1" ||
            typeof route.endpointId !== "string" || !route.endpointId) {
          const cableMissing = route.virtualCableInstalled === false && route.virtualCableCount === 0;
          const cableAmbiguous = route.virtualCableInstalled === false && route.virtualCableCount > 1;
          const error = new Error(cableMissing
            ? "Install VB-CABLE from VB-Audio, restart Windows, then check the audio route again"
            : cableAmbiguous
              ? "Windows exposes multiple base VB-CABLE Input endpoints; remove the duplicate or stale VB-CABLE installation"
            : "Windows route self-test did not prove the virtual-endpoint contract");
          error.code = cableMissing
            ? "windows_vb_cable_required"
            : cableAmbiguous
              ? "windows_vb_cable_ambiguous"
            : "windows_native_route_failed";
          throw error;
        }
        return {
          ready: true,
          code: "ready",
          detail: "WASAPI process capture and VB-CABLE Input passed their native self-tests",
          sourceFormat: {
            sampleRate: capture.sampleRate,
            channels: capture.channels,
            sampleFormat: capture.sampleFormat,
          },
          suppressionEndpointId: route.endpointId,
        };
      } catch (error) {
        return {
          ready: false,
          code: error?.code || "windows_native_route_failed",
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

  resolveProcesses(settings) {
    return settings?.sourceId
      ? this.processResolver({ sourceId: settings.sourceId, platform: this.platform })
      : this.defaultProcessResolver({ platform: this.platform });
  }

  resolveProcessesForProbe(settings) {
    const key = settings?.sourceId || "__default_voice_process__";
    const existing = this.processProbeInFlight.get(key);
    if (existing) return existing;
    const resolving = Promise.resolve().then(() => this.resolveProcesses(settings));
    this.processProbeInFlight.set(key, resolving);
    return resolving.finally(() => {
      if (this.processProbeInFlight.get(key) === resolving) {
        this.processProbeInFlight.delete(key);
      }
    });
  }

  async probe(settings) {
    const helpers = await this.helperReadiness();
    if (!helpers.ready) return helpers;
    try {
      const processes = await this.resolveProcessesForProbe(settings);
      if (processes.pids.length === 0 || processes.rootPids.length === 0) {
        return {
          ready: false,
          code: "desktop_source_not_running",
          detail: settings?.sourceName
            ? `${settings.sourceName} is not currently running`
            : "Start ChatGPT or Codex, or select another running application",
        };
      }
      if (processes.rootPids.length !== 1) {
        return {
          ready: false,
          code: "windows_source_selection_required",
          detail: "Select one ChatGPT or Codex application; one WASAPI process-loopback stream owns one process tree",
        };
      }
      return {
        ready: true,
        code: "ready",
        detail: "Selected Windows process tree is ready; route it to CABLE Input in Volume Mixer",
      };
    } catch (error) {
      return {
        ready: false,
        code: "desktop_source_discovery_failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async describe(settings) {
    const helpers = await this.helperReadiness();
    if (!helpers.ready) throw new Error(helpers.detail);
    return { ...helpers.sourceFormat };
  }

  async acquire(settings, onRouteError, onRouteStatus, { signal } = {}) {
    if (this.captureChild || this.routeChild) throw new Error("A Windows process route is already acquired");
    if (typeof onRouteError !== "function" || typeof onRouteStatus !== "function") {
      throw new Error("Windows route error and lifecycle handlers are required");
    }
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Windows route acquisition was cancelled");
    const helpers = await this.helperReadiness();
    if (!helpers.ready) throw new Error(helpers.detail);
    const processes = await this.resolveProcesses(settings);
    if (processes.pids.length === 0 || processes.rootPids.length === 0) {
      throw new Error(settings?.sourceName
        ? `${settings.sourceName} is not currently running`
        : "Start ChatGPT or Codex, or select another running application");
    }
    if (processes.rootPids.length !== 1) {
      throw new Error("Windows process-loopback requires exactly one selected process tree");
    }

    this.routeErrorHandler = onRouteError;
    this.routeStatusHandler = onRouteStatus;
    this.routeState = null;
    this.expectedSequence = null;
    this.suppressionUncertain = false;
    this.releaseFailure = null;
    this.closing = false;

    const rootArguments = processes.rootPids.flatMap((processId) => ["--root-pid", String(processId)]);
    const routeChild = this.spawnProcess(this.routeHelperPath, [
      "--suppression-endpoint-id", helpers.suppressionEndpointId,
      ...rootArguments,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.routeChild = routeChild;
    try {
      await this.awaitRouteReady(routeChild, helpers.suppressionEndpointId, signal);
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Windows route acquisition was cancelled");
      const captureChild = this.spawnProcess(this.captureHelperPath, rootArguments, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      this.captureChild = captureChild;
      await this.awaitCaptureReady(captureChild, processes.rootPids[0], signal);
      if (!this.isArmed()) throw new Error("Windows native route became unavailable before acquisition completed");
      onRouteStatus({
        type: "status",
        state: this.routeState,
        reason: "route_acquired",
        originalSuppressed: this.routeState === "engaged",
      });
      return this.createSessionGuard();
    } catch (error) {
      this.closing = true;
      const cleanupErrors = [];
      const captureChild = this.captureChild;
      const routeChild = this.routeChild;
      if (captureChild) {
        try { await this.terminateProcess(captureChild); }
        catch (cleanupError) {
          if (this.childIsLive(captureChild)) cleanupErrors.push(cleanupError);
        }
        if (this.childIsLive(captureChild) && cleanupErrors.length === 0) {
          cleanupErrors.push(new Error("Windows capture termination returned without process-exit proof"));
        }
      }
      if (routeChild) {
        try {
          await this.stopRouteVerifier(routeChild);
        } catch (cleanupError) {
          if (this.childIsLive(routeChild)) cleanupErrors.push(cleanupError);
        }
      }
      this.captureChild = this.childIsLive(captureChild) ? captureChild : null;
      this.routeChild = this.childIsLive(routeChild) ? routeChild : null;
      if (!this.captureChild) this.captureReady = null;
      if (!this.routeChild) {
        this.routeReady = null;
        this.routeState = null;
      }
      this.closing = false;
      if (cleanupErrors.length > 0) {
        this.suppressionUncertain = true;
        const failure = new Error(
          `Windows route acquisition failed (${error instanceof Error ? error.message : String(error)}) and cleanup was not proven: ` +
          cleanupErrors.map((entry) => entry instanceof Error ? entry.message : String(entry)).join("; "),
        );
        failure.code = "windows_route_acquire_cleanup_unproven";
        failure.suppressionHeld = true;
        failure.suppressionSession = this.createSessionGuard();
        this.routeErrorHandler = null;
        this.routeStatusHandler = null;
        throw failure;
      }
      this.routeErrorHandler = null;
      this.routeStatusHandler = null;
      throw error;
    }
  }

  awaitRouteReady(child, suppressionEndpointId, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stderr = "";
      const timeout = setTimeout(() => finish(new Error("Windows route verifier did not become ready within 10 seconds")), 10_000);
      timeout.unref?.();
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abortHandler);
        if (error) reject(error);
        else resolve();
      };
      const abortHandler = () => finish(signal.reason instanceof Error ? signal.reason : new Error("Windows route acquisition was cancelled"));
      signal?.addEventListener("abort", abortHandler, { once: true });
      const parser = new NativeFrameParser((message) => {
        if (message.type === "ready") {
          if (this.routeReady || message.helper !== "route" ||
              message.backend !== "windows-virtual-endpoint-verifier" ||
              message.virtualCableInstalled !== true || message.routeMutation !== false ||
              message.virtualCableCount !== 1 ||
              message.manualAssignmentRequired !== true ||
              message.restoreRequired !== true ||
              message.restoreMechanism !== "manual-volume-mixer" ||
              message.standbyPassthroughRequired !== true ||
              message.supportsCurrentSessionMembershipProof !== true ||
              message.supportsEventDrivenMonitoring !== true ||
              message.notificationGuaranteesPreAudio !== false ||
              message.proofScope !== "current-live-sessions" ||
              message.sinkIdentity !== "vb-audio-vb-cable-input-v1" ||
              message.armed !== true || !["armed", "engaged"].includes(message.state) ||
              message.originalSuppressed !== (message.state === "engaged") ||
              message.endpointId !== suppressionEndpointId) {
            finish(new Error("Windows route helper emitted invalid readiness"));
            return;
          }
          this.routeReady = message;
          this.routeState = message.state;
          finish();
        } else if (message.type === "status") {
          this.handleRouteStatus(message);
        } else if (message.type === "error") {
          const error = new Error(message.message || "Windows route verification failed");
          error.code = message.code || "windows_route_failed";
          error.suppressionHeld = message.suppressionHeld === true;
          if (!settled) finish(error);
          else this.handleRouteFailure(error);
        } else {
          finish(new Error("Windows route helper emitted an unexpected CPV1 frame"));
        }
      });
      child.stdout.on("data", (chunk) => {
        try { parser.push(chunk); }
        catch (error) { if (!settled) finish(error); else this.handleRouteFailure(error); }
      });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
      child.once("error", (error) => { if (!settled) finish(error); else this.handleRouteFailure(error); });
      child.once("exit", (code, exitSignal) => {
        try { parser.finish(); }
        catch (error) { if (!settled) finish(error); else this.handleRouteFailure(error); return; }
        this.routeReady = null;
        this.routeState = null;
        if (!settled) {
          finish(new Error(stderr.trim() ||
            `Windows route helper exited before readiness (code=${String(code)}, signal=${String(exitSignal)})`));
        } else if (!this.closing) {
          const error = new Error(stderr.trim() || "Windows route verifier exited unexpectedly; suppression is no longer proven");
          error.code = "windows_route_verifier_exited";
          error.suppressionHeld = true;
          this.handleRouteFailure(error);
        }
      });
    });
  }

  awaitCaptureReady(child, rootPid, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stderr = "";
      const timeout = setTimeout(() => finish(new Error("Windows process-loopback capture did not become ready within 10 seconds")), 10_000);
      timeout.unref?.();
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abortHandler);
        if (error) reject(error);
        else resolve();
      };
      const abortHandler = () => finish(signal.reason instanceof Error ? signal.reason : new Error("Windows capture acquisition was cancelled"));
      signal?.addEventListener("abort", abortHandler, { once: true });
      const parser = new NativeFrameParser((message) => {
        if (message.type === "ready") {
          if (this.captureReady || message.helper !== "capture" ||
              message.backend !== "wasapi-process-loopback" ||
              message.protocolVersion !== 1 ||
              message.rootPid !== rootPid || message.sampleRate !== 48_000 ||
              message.channels !== 2 || message.sampleFormat !== "f32le" ||
              message.supportsCaptureProof !== true || message.supportsSuppression !== false) {
            finish(new Error("Windows capture helper emitted invalid readiness"));
            return;
          }
          this.captureReady = message;
          finish();
        } else if (message.type === "audio") {
          if (!this.captureReady) finish(new Error("Windows capture emitted PCM before readiness"));
          else this.handleAudio(message);
        } else if (message.type === "error") {
          const error = new Error(message.message || "Windows process-loopback capture failed");
          error.code = message.code || "windows_capture_failed";
          if (!settled) finish(error);
          else this.handleStreamFailure(error);
        } else {
          finish(new Error("Windows capture emitted an unexpected CPV1 frame"));
        }
      });
      child.stdout.on("data", (chunk) => {
        try { parser.push(chunk); }
        catch (error) { if (!settled) finish(error); else this.handleStreamFailure(error); }
      });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
      child.once("error", (error) => { if (!settled) finish(error); else this.handleStreamFailure(error); });
      child.once("exit", (code, exitSignal) => {
        try { parser.finish(); }
        catch (error) { if (!settled) finish(error); else this.handleStreamFailure(error); return; }
        this.captureReady = null;
        if (!settled) {
          finish(new Error(stderr.trim() ||
            `Windows capture helper exited before readiness (code=${String(code)}, signal=${String(exitSignal)})`));
        } else if (!this.closing) {
          this.handleStreamFailure(new Error(stderr.trim() ||
            `Windows capture helper exited unexpectedly (code=${String(code)}, signal=${String(exitSignal)})`));
        }
      });
    });
  }

  handleRouteStatus(message) {
    const valid = message.helper === "route" &&
      ((message.state === "armed" && message.originalSuppressed === false) ||
       (message.state === "engaged" && message.originalSuppressed === true)) &&
      message.routeVerified === true;
    if (!valid) {
      const error = new Error("Windows route helper emitted an invalid lifecycle status");
      error.code = "windows_route_protocol_error";
      error.suppressionHeld = true;
      this.handleRouteFailure(error);
      return;
    }
    this.routeState = message.state;
    this.suppressionUncertain = false;
    this.expectedSequence = null;
    this.routeStatusHandler?.({ ...message });
  }

  handleAudio(message) {
    if (this.routeState !== "engaged" || !this.frameHandler) return;
    if (this.expectedSequence !== null && message.sequence !== this.expectedSequence) {
      this.handleStreamFailure(new Error(
        `Windows capture sequence gap: expected ${this.expectedSequence}, received ${message.sequence}`,
      ));
      return;
    }
    this.expectedSequence = (message.sequence + 1) >>> 0;
    this.frameHandler({
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

  handleStreamFailure(error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    normalized.code ||= "windows_capture_failed";
    this.frameHandler = null;
    if (!this.streamErrorHandler) {
      this.logger?.error("native.windows_capture_failed", { message: normalized.message });
      return;
    }
    const handler = this.streamErrorHandler;
    this.streamErrorHandler = null;
    handler(normalized);
  }

  handleRouteFailure(error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    normalized.code ||= "windows_route_failed";
    this.frameHandler = null;
    this.streamErrorHandler = null;
    this.routeStatusHandler = null;
    if (normalized.suppressionHeld === true) this.suppressionUncertain = true;
    else {
      this.routeState = null;
      this.routeReady = null;
      this.suppressionUncertain = false;
    }
    if (!this.routeErrorHandler) {
      this.logger?.error("native.windows_route_failed", { message: normalized.message });
      return;
    }
    const handler = this.routeErrorHandler;
    this.routeErrorHandler = null;
    handler(normalized);
  }

  open(_settings, onFrame, onError) {
    if (!this.isArmed()) throw new Error("Windows process route must be armed before capture opens");
    if (this.frameHandler) throw new Error("The Windows process capture stream is already open");
    if (typeof onFrame !== "function" || typeof onError !== "function") {
      throw new Error("Windows capture frame and error handlers are required");
    }
    this.expectedSequence = null;
    this.frameHandler = onFrame;
    this.streamErrorHandler = onError;
    return {
      format: {
        sampleRate: this.captureReady.sampleRate,
        channels: this.captureReady.channels,
        sampleFormat: this.captureReady.sampleFormat,
      },
      close: async () => {
        this.frameHandler = null;
        this.streamErrorHandler = null;
      },
    };
  }

  createSessionGuard() {
    const route = this;
    return {
      get armed() { return route.isArmed(); },
      get originalSuppressed() { return route.isSuppressed(); },
      get restorationUnproven() { return route.suppressionUncertain; },
      format: this.captureReady ? {
        sampleRate: this.captureReady.sampleRate,
        channels: this.captureReady.channels,
        sampleFormat: this.captureReady.sampleFormat,
      } : null,
      close: () => this.release(),
    };
  }

  async release() {
    if (this.releasePromise) return this.releasePromise;
    const release = this.releaseOnce();
    this.releasePromise = release;
    try { await release; }
    finally { if (this.releasePromise === release) this.releasePromise = null; }
  }

  async releaseOnce() {
    const captureChild = this.captureChild;
    const routeChild = this.routeChild;
    if (!captureChild && !routeChild) {
      if (this.suppressionUncertain) {
        const error = new Error("Windows route verification remains unproven without a helper handle");
        error.code = "source_suppression_release_unproven";
        error.suppressionHeld = true;
        throw error;
      }
      return;
    }
    this.closing = true;
    this.frameHandler = null;
    this.streamErrorHandler = null;
    const errors = [];
    if (captureChild) {
      try { await this.terminateProcess(captureChild); }
      catch (error) {
        if (this.childIsLive(captureChild)) {
          errors.push(`capture: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (this.childIsLive(captureChild) && errors.length === 0) {
        errors.push("capture: termination returned without process-exit proof");
      }
    }
    if (errors.length === 0 && routeChild) {
      try {
        await this.stopRouteVerifier(routeChild);
      } catch (error) {
        if (this.childIsLive(routeChild)) {
          errors.push(`route: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (errors.length > 0) {
      this.closing = false;
      this.suppressionUncertain = true;
      const failure = new Error(`Windows native route shutdown was not proven: ${errors.join("; ")}`);
      failure.code = "source_suppression_release_unproven";
      failure.suppressionHeld = true;
      throw failure;
    }
    this.captureChild = null;
    this.routeChild = null;
    this.captureReady = null;
    this.routeReady = null;
    this.routeState = null;
    this.routeErrorHandler = null;
    this.routeStatusHandler = null;
    this.expectedSequence = null;
    this.suppressionUncertain = false;
    this.closing = false;
  }
}

module.exports = {
  PROBE_CACHE_MS,
  WINDOWS_PROCESS_LOOPBACK_MINIMUM_BUILD,
  WindowsProcessRoute,
};
