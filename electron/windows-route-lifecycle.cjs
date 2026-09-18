"use strict";

const MAX_PASSTHROUGH_QUEUED_MS = 250;
const MAX_CONVERSION_HANDOFF_QUEUED_MS = 5_000;

const WINDOWS_MANUAL_RESTORE = Object.freeze({
  code: "windows_manual_route_restore_required",
  title: "Restore the selected application output route before quitting",
  steps: Object.freeze([
    "Open Windows Settings > System > Sound > Volume mixer.",
    "Set the selected application Output device back to Default or your physical listening device.",
    "Confirm the change in Persona Voice before quitting or uninstalling.",
  ]),
});

function sourceIdentity(settings) {
  return JSON.stringify({
    sourceMode: settings?.sourceMode ?? null,
    targetApp: settings?.targetApp ?? null,
    sourceId: settings?.sourceId ?? null,
  });
}

function frameDurationMs(frame) {
  if (!Number.isInteger(frame?.samplesPerChannel) || frame.samplesPerChannel <= 0 ||
      !Number.isInteger(frame?.sampleRate) || frame.sampleRate <= 0) {
    throw new Error("Windows standby passthrough received invalid audio duration metadata");
  }
  return frame.samplesPerChannel * 1000 / frame.sampleRate;
}

function normalizedError(error, fallbackCode) {
  const value = error instanceof Error ? error : new Error(String(error));
  value.code ||= fallbackCode;
  return value;
}

class WindowsRouteLifecycle {
  constructor({
    processRoute,
    audioOutput,
    logger = null,
    manualRouteConfigured = false,
    onManualRouteConfigured = null,
  }) {
    if (!processRoute || !audioOutput) {
      throw new Error("Windows route lifecycle requires process-route and audio-output adapters");
    }
    this.processRoute = processRoute;
    this.audioOutput = audioOutput;
    this.logger = logger;
    this.onManualRouteConfigured = onManualRouteConfigured;
    this.state = "cold";
    this.settings = null;
    this.settingsIdentity = null;
    this.baseGuard = null;
    this.captureStream = null;
    this.standbyOutput = null;
    this.standbyGeneration = 0;
    this.standbyWriteQueue = Promise.resolve();
    this.standbyQueuedMs = 0;
    this.standbyFailure = null;
    this.conversionStream = null;
    this.conversionFrameHandler = null;
    this.conversionStreamError = null;
    this.conversionActivated = false;
    this.conversionPendingFrames = [];
    this.conversionPendingMs = 0;
    this.conversionGuardOpen = false;
    this.conversionRouteError = null;
    this.conversionRouteStatus = null;
    this.conversionFailure = null;
    this.standbyError = null;
    this.standbyStatus = null;
    this.lastRouteStatus = null;
    this.routeFailure = null;
    this.currentSessionOffSinkObserved = false;
    this.manualRestoreRequested = false;
    this.manualRouteMayPersist = manualRouteConfigured === true;
    this.transitionQueue = Promise.resolve();
    this.faultCleanupPromise = null;
  }

  snapshot() {
    return {
      state: this.state,
      routeHeld: Boolean(this.baseGuard),
      standbyActive: this.state === "standby" && Boolean(this.captureStream && this.standbyOutput),
      conversionActive: this.state === "conversion",
      manualRestoreRequired: this.manualRouteMayPersist,
      currentSessionOffSinkObserved: this.currentSessionOffSinkObserved,
      persistentRoutingResetProven: false,
      errorCode: this.routeFailure?.code ?? this.standbyFailure?.code ?? this.conversionFailure?.code ?? null,
      error: this.routeFailure?.message ?? this.standbyFailure?.message ?? this.conversionFailure?.message ?? null,
    };
  }

  async probe(settings) {
    if (this.state === "awaiting-restore") {
      return {
        ready: false,
        code: WINDOWS_MANUAL_RESTORE.code,
        detail: WINDOWS_MANUAL_RESTORE.title,
      };
    }
    if (this.routeFailure || this.standbyFailure || this.conversionFailure) {
      const failure = this.routeFailure || this.standbyFailure || this.conversionFailure;
      return {
        ready: false,
        code: failure.code || "windows_route_lifecycle_faulted",
        detail: failure.message,
      };
    }
    if (this.state === "shutdown") {
      return {
        ready: false,
        code: "windows_route_lifecycle_shutdown",
        detail: "The Windows audio-route lifecycle is shutting down",
      };
    }
    return this.processRoute.probe(settings);
  }

  describe(settings) {
    return this.processRoute.describe(settings);
  }

  serialize(operation) {
    const result = this.transitionQueue.then(operation, operation);
    this.transitionQueue = result.catch(() => {});
    return result;
  }

  markManualRouteConfigured() {
    const changed = !this.manualRouteMayPersist;
    this.manualRouteMayPersist = true;
    if (changed) this.onManualRouteConfigured?.();
    return this.snapshot();
  }

  assertSameSource(settings) {
    if (this.settingsIdentity !== null && this.settingsIdentity !== sourceIdentity(settings)) {
      const error = new Error(
        "Restore the existing Windows application route before selecting a different source",
      );
      error.code = "windows_source_change_requires_route_restore";
      throw error;
    }
  }

  async ensureBaseRoute(settings, signal) {
    this.assertSameSource(settings);
    if (this.baseGuard) {
      if (this.routeFailure) throw this.routeFailure;
      if (this.baseGuard.armed !== true) {
        throw new Error("The retained Windows route is no longer armed");
      }
      return;
    }
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("Windows route startup was cancelled");
    }
    this.settings = { ...settings };
    this.settingsIdentity = sourceIdentity(settings);
    try {
      this.baseGuard = await this.processRoute.acquire(
        settings,
        (error) => this.handleUnderlyingRouteError(error),
        (status) => this.handleUnderlyingRouteStatus(status),
        { signal },
      );
      if (this.baseGuard?.armed !== true || typeof this.baseGuard?.close !== "function") {
        throw new Error("Windows route acquisition did not return an armed lifecycle guard");
      }
      this.markManualRouteConfigured();
      this.state = "base-ready";
    } catch (error) {
      if (error?.suppressionSession && !this.baseGuard) {
        this.baseGuard = error.suppressionSession;
        error.suppressionSession = this.lifecycleGuard();
      }
      if (this.baseGuard) this.state = "faulted";
      throw error;
    }
  }

  async startStandby(settings, {
    onError = () => {},
    onStatus = () => {},
    signal,
  } = {}) {
    if (typeof onError !== "function" || typeof onStatus !== "function") {
      throw new Error("Windows standby lifecycle handlers must be functions");
    }
    return this.serialize(async () => {
      if (this.state === "shutdown") throw new Error("The Windows route lifecycle is already shut down");
      if (this.state === "awaiting-restore") throw this.manualRestoreError();
      if (this.state === "conversion") {
        throw new Error("Cannot start Windows standby passthrough during voice conversion");
      }
      this.standbyError = onError;
      this.standbyStatus = onStatus;
      if (this.faultCleanupPromise) {
        await this.faultCleanupPromise;
        this.faultCleanupPromise = null;
      }
      await this.ensureBaseRoute(settings, signal);
      if (this.state !== "standby") await this.resumeStandby();
      return this.snapshot();
    });
  }

  async resumeStandby() {
    if (!this.baseGuard || this.baseGuard.armed !== true || this.routeFailure) {
      throw this.routeFailure || new Error("Windows standby cannot start without an armed route");
    }
    if (this.standbyOutput) throw new Error("Windows standby output already exists");
    const generation = ++this.standbyGeneration;
    this.standbyFailure = null;
    this.standbyWriteQueue = Promise.resolve();
    this.standbyQueuedMs = 0;
    this.conversionActivated = false;
    this.conversionPendingFrames = [];
    this.conversionPendingMs = 0;
    let output = null;
    try {
      this.state = "standby-starting";
      this.ensureCaptureStream();
      output = await this.audioOutput.prepare(
        { ...this.settings, outputMode: "passthrough" },
        this.baseGuard.format,
        (error) => this.handleStandbyFailure(error, generation),
      );
      if (generation !== this.standbyGeneration) {
        await output.close();
        throw new Error("Windows standby startup was superseded");
      }
      this.standbyOutput = output;
      const pending = this.conversionPendingFrames;
      this.conversionPendingFrames = [];
      this.conversionPendingMs = 0;
      this.state = "standby";
      for (const frame of pending) this.enqueuePassthrough(frame, generation);
      if (this.lastRouteStatus) this.standbyStatus?.({ ...this.lastRouteStatus });
    } catch (error) {
      this.standbyFailure = normalizedError(error, "windows_standby_start_failed");
      if (error?.outputSession && !this.standbyOutput) this.standbyOutput = error.outputSession;
      if (output && !this.standbyOutput) this.standbyOutput = output;
      try {
        await this.closeStandbyResources();
      } catch (cleanupError) {
        this.standbyFailure.message += `; ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
        this.standbyFailure.suppressionSession = this.lifecycleGuard();
      }
      this.state = "faulted";
      throw this.standbyFailure;
    }
  }

  ensureCaptureStream() {
    if (this.captureStream) return this.captureStream;
    this.captureStream = this.processRoute.open(
      this.settings,
      (frame) => this.handleCapturedFrame(frame),
      (error) => this.handleCaptureFailure(error),
    );
    return this.captureStream;
  }

  handleCapturedFrame(frame) {
    if (this.state === "conversion" || this.state === "standby-starting") {
      if (this.conversionActivated && this.conversionFrameHandler) {
        this.conversionFrameHandler(frame);
      } else {
        this.enqueueConversionHandoff(frame);
      }
      return;
    }
    if (this.state === "standby" || this.state === "awaiting-restore") {
      this.enqueuePassthrough(frame, this.standbyGeneration);
    }
  }

  enqueueConversionHandoff(frame) {
    let durationMs;
    try { durationMs = frameDurationMs(frame); }
    catch (error) { this.handleConversionStreamFailure(error); return; }
    if (this.conversionPendingMs + durationMs > MAX_CONVERSION_HANDOFF_QUEUED_MS) {
      const error = new Error(
        `Windows conversion handoff exceeded ${MAX_CONVERSION_HANDOFF_QUEUED_MS} ms; original audio remains isolated`,
      );
      error.code = "windows_conversion_handoff_queue_exceeded";
      error.suppressionHeld = this.baseGuard?.originalSuppressed === true;
      this.handleConversionStreamFailure(error);
      return;
    }
    this.conversionPendingFrames.push(frame);
    this.conversionPendingMs += durationMs;
  }

  handleCaptureFailure(error) {
    this.captureStream = null;
    if (this.state === "conversion") {
      this.handleConversionStreamFailure(error);
      return;
    }
    this.handleStandbyFailure(error, this.standbyGeneration);
  }

  handleConversionStreamFailure(error) {
    if (this.state === "shutdown" || this.state === "faulted") return;
    if (this.state === "standby-starting") {
      this.handleStandbyFailure(error, this.standbyGeneration);
      return;
    }
    const failure = normalizedError(error, "windows_capture_failed");
    failure.suppressionHeld = this.baseGuard?.originalSuppressed === true;
    this.conversionFailure = failure;
    this.conversionActivated = false;
    this.state = "faulted";
    const handler = this.conversionStreamError || this.conversionRouteError;
    handler?.(failure);
    this.logger?.error("native.windows_conversion_capture_failed", { message: failure.message });
  }

  enqueuePassthrough(frame, generation) {
    if (generation !== this.standbyGeneration ||
        (this.state !== "standby" && this.state !== "awaiting-restore") ||
        !this.standbyOutput) return;
    let durationMs;
    try { durationMs = frameDurationMs(frame); }
    catch (error) { this.handleStandbyFailure(error, generation); return; }
    if (this.standbyQueuedMs + durationMs > MAX_PASSTHROUGH_QUEUED_MS) {
      const error = new Error(
        `Windows standby passthrough exceeded ${MAX_PASSTHROUGH_QUEUED_MS} ms; original audio remains isolated`,
      );
      error.code = "windows_standby_queue_exceeded";
      error.suppressionHeld = true;
      this.handleStandbyFailure(error, generation);
      return;
    }
    this.standbyQueuedMs += durationMs;
    const output = this.standbyOutput;
    this.standbyWriteQueue = this.standbyWriteQueue
      .then(() => output.write(frame))
      .catch((error) => { this.handleStandbyFailure(error, generation); })
      .finally(() => { this.standbyQueuedMs = Math.max(0, this.standbyQueuedMs - durationMs); });
  }

  handleStandbyFailure(error, generation) {
    if (generation !== this.standbyGeneration || this.state === "shutdown") return;
    const failure = normalizedError(error, "windows_standby_failed");
    failure.suppressionHeld = this.baseGuard?.originalSuppressed === true;
    if (this.standbyFailure) return;
    this.standbyFailure = failure;
    this.state = "faulted";
    this.standbyError?.(failure);
    this.logger?.error("native.windows_standby_failed", { message: failure.message });
    this.faultCleanupPromise = this.closeStandbyResources().catch((cleanupError) => {
      failure.message += `; standby cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
      failure.suppressionSession = this.lifecycleGuard();
    });
  }

  handleUnderlyingRouteStatus(status) {
    this.lastRouteStatus = { ...status };
    const handler = this.state === "conversion" ? this.conversionRouteStatus : this.standbyStatus;
    handler?.({ ...status });
  }

  handleUnderlyingRouteError(error) {
    const failure = normalizedError(error, "windows_route_failed");
    this.routeFailure = failure;
    if (failure.code === "windows_target_route_lost" && failure.suppressionHeld !== true) {
      this.currentSessionOffSinkObserved = true;
    }
    const handler = this.state === "conversion" ? this.conversionRouteError : this.standbyError;
    if (this.state !== "awaiting-restore") this.state = "faulted";
    handler?.(failure);
    this.faultCleanupPromise = this.closeStandbyResources().catch((cleanupError) => {
      failure.message += `; standby cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
      failure.suppressionSession = this.lifecycleGuard();
    });
  }

  async closeStandbyResources() {
    const stream = this.captureStream;
    const output = this.standbyOutput;
    const writes = this.standbyWriteQueue;
    this.standbyGeneration += 1;
    this.captureStream = null;
    this.standbyOutput = null;
    this.conversionActivated = false;
    this.conversionPendingFrames = [];
    this.conversionPendingMs = 0;
    const errors = [];
    if (stream) {
      try { await stream.close(); }
      catch (error) { errors.push(`capture: ${error instanceof Error ? error.message : String(error)}`); }
    }
    try { await writes; }
    catch (error) { errors.push(`queue: ${error instanceof Error ? error.message : String(error)}`); }
    if (output) {
      try { await output.close(); }
      catch (error) {
        errors.push(`output: ${error instanceof Error ? error.message : String(error)}`);
        if (output) this.standbyOutput = output;
      }
    }
    this.standbyWriteQueue = Promise.resolve();
    this.standbyQueuedMs = 0;
    if (errors.length > 0) {
      const failure = new Error(`Windows standby shutdown was not proven: ${errors.join("; ")}`);
      failure.code = "windows_standby_cleanup_unproven";
      failure.suppressionHeld = this.baseGuard?.originalSuppressed === true;
      failure.suppressionSession = this.lifecycleGuard();
      throw failure;
    }
  }

  async closeStandbyOutput() {
    const output = this.standbyOutput;
    const writes = this.standbyWriteQueue;
    this.standbyGeneration += 1;
    this.standbyOutput = null;
    const errors = [];
    try { await writes; }
    catch (error) { errors.push(`queue: ${error instanceof Error ? error.message : String(error)}`); }
    if (output) {
      try { await output.close(); }
      catch (error) {
        errors.push(`output: ${error instanceof Error ? error.message : String(error)}`);
        this.standbyOutput = output;
      }
    }
    this.standbyWriteQueue = Promise.resolve();
    this.standbyQueuedMs = 0;
    if (errors.length > 0) {
      const failure = new Error(`Windows standby output shutdown was not proven: ${errors.join("; ")}`);
      failure.code = "windows_standby_cleanup_unproven";
      failure.suppressionHeld = this.baseGuard?.originalSuppressed === true;
      failure.suppressionSession = this.lifecycleGuard();
      throw failure;
    }
  }

  async acquire(settings, onRouteError, onRouteStatus, { signal } = {}) {
    if (typeof onRouteError !== "function" || typeof onRouteStatus !== "function") {
      throw new Error("Windows conversion route lifecycle handlers are required");
    }
    return this.serialize(async () => {
      if (this.state === "shutdown") throw new Error("The Windows route lifecycle is already shut down");
      if (this.state === "awaiting-restore") throw this.manualRestoreError();
      if (this.state === "conversion" || this.conversionGuardOpen) {
        throw new Error("A Windows conversion route is already acquired");
      }
      if (this.state === "faulted" && this.standbyFailure) throw this.standbyFailure;
      await this.ensureBaseRoute(settings, signal);
      if (this.routeFailure) throw this.routeFailure;
      this.conversionRouteError = onRouteError;
      this.conversionRouteStatus = onRouteStatus;
      this.conversionGuardOpen = true;
      this.conversionActivated = false;
      this.conversionPendingFrames = [];
      this.conversionPendingMs = 0;
      this.conversionFailure = null;
      this.state = "conversion";
      try {
        this.ensureCaptureStream();
        await this.closeStandbyOutput();
        if (this.conversionFailure) throw this.conversionFailure;
      } catch (error) {
        this.state = "faulted";
        if (error && typeof error === "object" && !error.suppressionSession) {
          error.suppressionSession = this.conversionGuard();
        }
        throw error;
      }
      if (this.lastRouteStatus) onRouteStatus({ ...this.lastRouteStatus });
      return this.conversionGuard();
    });
  }

  open(settings, onFrame, onError) {
    if (this.state !== "conversion" || !this.conversionGuardOpen) {
      throw new Error("Acquire the Windows conversion route before opening capture");
    }
    if (this.conversionStream) throw new Error("The Windows conversion capture is already open");
    if (typeof onFrame !== "function" || typeof onError !== "function") {
      throw new Error("Windows conversion frame and error handlers are required");
    }
    this.assertSameSource(settings);
    this.ensureCaptureStream();
    this.conversionFrameHandler = onFrame;
    this.conversionStreamError = onError;
    let closed = false;
    const stream = {
      format: { ...this.baseGuard.format },
      activate: async () => {
        if (closed || this.conversionStream !== stream || this.state !== "conversion") {
          throw new Error("The Windows conversion capture cannot be activated in its current state");
        }
        const pending = this.conversionPendingFrames;
        this.conversionPendingFrames = [];
        this.conversionPendingMs = 0;
        this.conversionActivated = true;
        try {
          for (const frame of pending) onFrame(frame);
        } catch (error) {
          this.handleConversionStreamFailure(error);
          throw error;
        }
      },
      pause: async () => {
        if (closed || this.conversionStream !== stream) return;
        this.conversionActivated = false;
      },
      close: async () => {
        if (closed) return;
        closed = true;
        this.conversionActivated = false;
        this.conversionPendingFrames = [];
        this.conversionPendingMs = 0;
        this.conversionFrameHandler = null;
        this.conversionStreamError = null;
        if (this.conversionStream === stream) this.conversionStream = null;
      },
    };
    this.conversionStream = stream;
    return stream;
  }

  conversionGuard() {
    const lifecycle = this;
    let closed = false;
    return {
      get armed() { return !closed && lifecycle.baseGuard?.armed === true && !lifecycle.routeFailure; },
      get originalSuppressed() { return lifecycle.baseGuard?.originalSuppressed === true; },
      get restorationUnproven() { return lifecycle.baseGuard?.restorationUnproven === true; },
      format: this.baseGuard?.format ? { ...this.baseGuard.format } : null,
      close: async () => {
        if (closed) return;
        await lifecycle.serialize(async () => {
          if (lifecycle.conversionStream) {
            await lifecycle.conversionStream.close();
            lifecycle.conversionStream = null;
          }
          lifecycle.conversionRouteError = null;
          lifecycle.conversionRouteStatus = null;
          if (lifecycle.routeFailure?.code === "source_process_exited") {
            lifecycle.conversionGuardOpen = false;
            lifecycle.state = "faulted";
            closed = true;
            return;
          }
          if (lifecycle.routeFailure) {
            lifecycle.conversionGuardOpen = false;
            closed = true;
            throw lifecycle.routeFailure;
          }
          try {
            lifecycle.conversionFailure = null;
            await lifecycle.resumeStandby();
          } finally {
            lifecycle.conversionGuardOpen = false;
            closed = true;
          }
        });
      },
    };
  }

  lifecycleGuard() {
    const lifecycle = this;
    return {
      get armed() { return lifecycle.baseGuard?.armed === true; },
      get originalSuppressed() { return lifecycle.baseGuard?.originalSuppressed === true; },
      get restorationUnproven() { return lifecycle.baseGuard?.restorationUnproven === true; },
      close: () => lifecycle.shutdown(),
    };
  }

  manualRestoreError() {
    const error = new Error(WINDOWS_MANUAL_RESTORE.title);
    error.code = WINDOWS_MANUAL_RESTORE.code;
    error.requiresUserAction = true;
    error.steps = [...WINDOWS_MANUAL_RESTORE.steps];
    return error;
  }

  beginManualRestore() {
    return this.serialize(async () => {
      if (!this.manualRouteMayPersist) {
        return {
          required: false,
          routingResetProven: false,
          persistentRoutingResetProven: false,
        };
      }
      if (this.state === "conversion" || this.conversionGuardOpen) {
        const error = new Error("Stop voice conversion before restoring the Windows application route");
        error.code = "windows_stop_conversion_before_restore";
        throw error;
      }
      this.manualRestoreRequested = true;
      this.state = "awaiting-restore";
      return {
        required: true,
        code: WINDOWS_MANUAL_RESTORE.code,
        title: WINDOWS_MANUAL_RESTORE.title,
        steps: [...WINDOWS_MANUAL_RESTORE.steps],
        currentSessionOffSinkObserved: this.currentSessionOffSinkObserved,
        routingResetProven: this.currentSessionOffSinkObserved,
        persistentRoutingResetProven: false,
      };
    });
  }

  recoverStandbyAfterSourceRestart(settings, {
    onError = this.standbyError ?? (() => {}),
    onStatus = this.standbyStatus ?? (() => {}),
    signal,
  } = {}) {
    return this.serialize(async () => {
      this.assertSameSource(settings);
      if (this.routeFailure?.code !== "source_process_exited") {
        const error = new Error(
          "Windows standby recovery is allowed only after the owned source process exits",
        );
        error.code = "windows_source_restart_recovery_not_allowed";
        throw error;
      }
      if (this.conversionGuardOpen || this.conversionStream) {
        throw new Error("Stop the failed conversion session before recovering Windows standby");
      }
      if (this.faultCleanupPromise) await this.faultCleanupPromise;
      await this.closeStandbyResources();
      const previousGuard = this.baseGuard;
      if (!previousGuard) {
        throw new Error("Windows source-restart recovery lost ownership of the previous native route");
      }
      try {
        await previousGuard.close();
      } catch (error) {
        const failure = normalizedError(error, "windows_route_release_unproven");
        failure.suppressionSession = this.lifecycleGuard();
        throw failure;
      }
      this.baseGuard = null;
      this.routeFailure = null;
      this.standbyFailure = null;
      this.lastRouteStatus = null;
      this.currentSessionOffSinkObserved = false;
      this.manualRestoreRequested = false;
      this.state = "cold";
      this.standbyError = onError;
      this.standbyStatus = onStatus;
      await this.ensureBaseRoute(settings, signal);
      await this.resumeStandby();
      return this.snapshot();
    });
  }

  cancelManualRestore() {
    return this.serialize(async () => {
      if (this.state !== "awaiting-restore" || !this.manualRestoreRequested) {
        const error = new Error("No Windows manual-route restoration is awaiting confirmation");
        error.code = "windows_manual_route_restore_not_pending";
        throw error;
      }
      this.manualRestoreRequested = false;
      if (this.routeFailure || this.standbyFailure) {
        this.state = "faulted";
      } else if (this.captureStream && this.standbyOutput) {
        this.state = "standby";
      } else if (!this.baseGuard) {
        this.state = "cold";
      } else {
        this.state = "base-ready";
        await this.resumeStandby();
      }
      return this.snapshot();
    });
  }

  completeManualRestore({ userConfirmed = false } = {}) {
    return this.serialize(async () => {
      if (!this.baseGuard) {
        if (!this.manualRestoreRequested || (!userConfirmed && !this.currentSessionOffSinkObserved)) {
          throw this.manualRestoreError();
        }
        this.manualRouteMayPersist = false;
        this.manualRestoreRequested = false;
        this.state = "shutdown";
        return {
          released: true,
          routingResetProven: false,
          persistentRoutingResetProven: false,
          userConfirmed,
        };
      }
      if (!this.manualRestoreRequested) throw this.manualRestoreError();
      if (!userConfirmed && !this.currentSessionOffSinkObserved) throw this.manualRestoreError();
      if (this.faultCleanupPromise) await this.faultCleanupPromise;
      await this.closeStandbyResources();
      const guard = this.baseGuard;
      try {
        await guard.close();
      } catch (error) {
        const failure = normalizedError(error, "windows_route_release_unproven");
        failure.suppressionSession = this.lifecycleGuard();
        throw failure;
      }
      this.baseGuard = null;
      this.settings = null;
      this.settingsIdentity = null;
      this.conversionGuardOpen = false;
      this.conversionRouteError = null;
      this.conversionRouteStatus = null;
      this.manualRouteMayPersist = false;
      this.manualRestoreRequested = false;
      this.state = "shutdown";
      return {
        released: true,
        routingResetProven: this.currentSessionOffSinkObserved,
        persistentRoutingResetProven: false,
        userConfirmed,
      };
    });
  }

  shutdown() {
    return this.serialize(async () => {
      if (!this.manualRouteMayPersist) {
        this.state = "shutdown";
        return { released: true, routingResetProven: false, persistentRoutingResetProven: false };
      }
      throw this.manualRestoreError();
    });
  }
}

module.exports = {
  MAX_CONVERSION_HANDOFF_QUEUED_MS,
  MAX_PASSTHROUGH_QUEUED_MS,
  WINDOWS_MANUAL_RESTORE,
  WindowsRouteLifecycle,
  frameDurationMs,
  sourceIdentity,
};
