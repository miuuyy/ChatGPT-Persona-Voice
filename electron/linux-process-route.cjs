"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { NativeFrameParser } = require("./native-protocol.cjs");
const { probeNativeHelper, terminateChild } = require("./native-helper.cjs");
const {
  DEFAULT_TARGET_APP,
  targetAppLabel,
  targetAppLinuxRouteIds,
} = require("./target-apps.cjs");

const execFileAsync = promisify(execFile);
const PROBE_CACHE_MS = 5_000;
const POLICY_VERSION = 3;
const SUPPORTED_ROUTE_IDS = Object.freeze(["chatgpt", "codex", "grok-bot"]);

function linuxRouteId(...values) {
  const text = values.filter(Boolean).join(" ");
  const chatgpt = /(?:^|[\/\s_-])chat-?gpt(?:[\/\s_.-]|$)/i.test(text);
  const codex = /(?:^|[\/\s_-])(?:openai[\s_-]*)?codex(?:[\/\s_.-]|$)/i.test(text);
  const grokBot = /(?:^|[\/\s_-])grok[\s_-]?bot(?:[\/\s_.-]|$)/i.test(text);
  const matched = [
    chatgpt ? "chatgpt" : null,
    codex ? "codex" : null,
    grokBot ? "grok-bot" : null,
  ].filter(Boolean);
  return matched.length === 1 ? matched[0] : null;
}

function decodeBase64Url(value) {
  try { return Buffer.from(value, "base64url").toString("utf8"); }
  catch { return null; }
}

function readLinuxProcesses({ procRoot = "/proc", readFile = fs.readFileSync, readDir = fs.readdirSync } = {}) {
  const entries = [];
  for (const name of readDir(procRoot)) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    try {
      const status = readFile(path.join(procRoot, name, "status"), "utf8");
      const parent = /^PPid:\s+(\d+)/m.exec(status);
      const executable = fs.readlinkSync(path.join(procRoot, name, "exe"));
      const command = readFile(path.join(procRoot, name, "cmdline"), "utf8").replace(/\0/g, " ").trim();
      entries.push({ pid, parentId: Number(parent?.[1] || 0), executable, command });
    } catch {
      // Processes can exit between /proc enumeration and identity reads.
    }
  }
  return entries;
}

function descendants(processes, roots) {
  const included = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) {
      if (included.has(process.parentId) && !included.has(process.pid)) {
        included.add(process.pid);
        changed = true;
      }
    }
  }
  return included;
}

function minimalRoots(processes, candidates) {
  const byId = new Map(processes.map((entry) => [entry.pid, entry]));
  const selected = new Set(candidates);
  return [...selected].filter((pid) => {
    const visited = new Set([pid]);
    for (let current = byId.get(byId.get(pid)?.parentId); current && !visited.has(current.pid); current = byId.get(current.parentId)) {
      if (selected.has(current.pid)) return false;
      visited.add(current.pid);
    }
    return true;
  }).sort((left, right) => left - right);
}

function pipeWireIdentity(sourceId) {
  if (typeof sourceId !== "string" || !sourceId.startsWith("pipewire:stream:")) return null;
  try {
    const decoded = decodeBase64Url(sourceId.slice("pipewire:stream:".length));
    const identity = JSON.parse(decoded);
    return identity && typeof identity === "object" ? identity : null;
  } catch {
    return null;
  }
}

async function pipeWireProcessIds(sourceId, { run = execFileAsync } = {}) {
  const identity = pipeWireIdentity(sourceId);
  if (!identity) return [];
  const { stdout } = await run("pw-dump", [], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 3_000,
  });
  const objects = JSON.parse(stdout);
  const clients = new Map(objects
    .filter((entry) => entry?.type === "PipeWire:Interface:Client")
    .map((entry) => [String(entry.id), entry?.info?.props ?? {}]));
  const ids = new Set();
  for (const entry of objects) {
    if (entry?.type !== "PipeWire:Interface:Node") continue;
    const own = entry?.info?.props ?? {};
    if (own["media.class"] !== "Stream/Output/Audio") continue;
    const props = { ...(clients.get(String(own["client.id"])) ?? {}), ...own };
    const matches = String(props["application.name"] ?? "") === String(identity.application ?? "") &&
      String(props["application.process.binary"] ?? "") === String(identity.binary ?? "") &&
      String(props["node.name"] ?? "") === String(identity.node ?? "");
    const pid = Number(props["application.process.id"]);
    if (matches && Number.isInteger(pid) && pid > 0) ids.add(pid);
  }
  return [...ids];
}

async function resolveLinuxProcessTree(settings, {
  processes = null,
  run = execFileAsync,
  ownProcessId = process.pid,
} = {}) {
  const entries = processes ?? readLinuxProcesses();
  const targetApp = settings?.targetApp ?? DEFAULT_TARGET_APP;
  const allowedRouteIds = new Set(targetAppLinuxRouteIds(targetApp));
  let candidates = [];
  let routeId = null;
  if (settings?.sourceId?.startsWith("pipewire:stream:")) {
    const identity = pipeWireIdentity(settings.sourceId);
    routeId = linuxRouteId(identity?.application, identity?.binary, identity?.node);
    if (!routeId || !allowedRouteIds.has(routeId)) {
      throw new Error(`The selected PipeWire source does not belong to ${targetAppLabel(targetApp)}`);
    }
    candidates = await pipeWireProcessIds(settings.sourceId, { run });
  } else if (settings?.sourceId?.startsWith("process:linux:")) {
    const executable = decodeBase64Url(settings.sourceId.slice("process:linux:".length));
    if (!executable) throw new Error("The selected Linux process source id is invalid");
    routeId = linuxRouteId(executable);
    if (!routeId || !allowedRouteIds.has(routeId)) {
      throw new Error(`The selected Linux process does not belong to ${targetAppLabel(targetApp)}`);
    }
    candidates = entries.filter((entry) => entry.executable === executable).map((entry) => entry.pid);
  } else {
    const matched = entries.filter((entry) => {
      const candidateRouteId = linuxRouteId(entry.executable, entry.command);
      return entry.pid !== ownProcessId && allowedRouteIds.has(candidateRouteId);
    });
    const routeIds = new Set(matched.map((entry) => linuxRouteId(entry.executable, entry.command)).filter(Boolean));
    if (routeIds.size > 1) {
      throw new Error(`Multiple ${targetAppLabel(targetApp)} audio routes are active; close the unused application`);
    }
    routeId = [...routeIds][0] ?? null;
    candidates = matched.filter((entry) => linuxRouteId(entry.executable, entry.command) === routeId).map((entry) => entry.pid);
  }
  const own = descendants(entries, [ownProcessId]);
  candidates = candidates.filter((pid) => !own.has(pid));
  const rootPids = minimalRoots(entries, candidates);
  const included = descendants(entries, rootPids);
  return {
    routeId,
    rootPids,
    pids: entries.map((entry) => entry.pid).filter((pid) => included.has(pid) && !own.has(pid)).sort((a, b) => a - b),
  };
}

class LinuxProcessRoute {
  constructor({
    helperPath,
    platform = process.platform,
    exists = fs.existsSync,
    spawnProcess = spawn,
    processResolver = resolveLinuxProcessTree,
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
    this.probeHelper = probeHelper;
    this.terminateProcess = terminateProcess;
    this.logger = logger;
    this.clock = clock;
    this.child = null;
    this.ready = null;
    this.routeState = null;
    this.frameHandler = null;
    this.errorHandler = null;
    this.routeErrorHandler = null;
    this.routeStatusHandler = null;
    this.expectedSequence = null;
    this.suppressionUncertain = false;
    this.unresolvedReleaseError = null;
    this.releasePromise = null;
    this.releaseFailure = null;
    this.closing = false;
    this.cachedProbe = null;
    this.probeInFlight = null;
  }

  isArmed() {
    return Boolean(this.child && this.ready?.armed === true &&
      this.child.exitCode === null && this.child.signalCode === null);
  }

  isSuppressed() {
    return Boolean(this.unresolvedReleaseError?.suppressionHeld === true || this.suppressionUncertain ||
      (this.child && this.routeState === "engaged" &&
        this.child.exitCode === null && this.child.signalCode === null));
  }

  async helperReadiness() {
    if (this.platform !== "linux") {
      return { ready: false, code: "linux_only", detail: "The native PipeWire route is available only on Linux" };
    }
    if (!this.helperPath || !this.exists(this.helperPath)) {
      return { ready: false, code: "linux_capture_helper_missing", detail: "The Linux PipeWire capture helper is not built" };
    }
    const now = this.clock();
    if (this.cachedProbe && now - this.cachedProbe.at < PROBE_CACHE_MS) return this.cachedProbe.value;
    if (this.probeInFlight) return this.probeInFlight;
    const probe = (async () => {
      try {
        const result = await this.probeHelper(this.helperPath, "capture");
        if (!Number.isInteger(result.sampleRate) || !Number.isInteger(result.channels) ||
            result.sampleFormat !== "f32le" || result.supportsArming !== true ||
            result.supportsDeferredRoute !== true || result.supportsCaptureProof !== true ||
            result.supportsProcessScopedRouting !== true || result.supportsRollbackProof !== true ||
            result.supportsPrelinkedIngress !== true || result.supportsDynamicProcessStreams !== true ||
            result.supportsCrashRecovery !== true || result.policyProbeVerified !== true ||
            result.policyVersion !== POLICY_VERSION || result.routeOwner !== "wireplumber-prelink-policy" ||
            !Array.isArray(result.supportedRouteIds) ||
            SUPPORTED_ROUTE_IDS.some((routeId) => !result.supportedRouteIds.includes(routeId))) {
          throw new Error("Capture self-test did not prove pre-linked WirePlumber routing and crash recovery");
        }
        return {
          ready: true,
          code: "ready",
          detail: "WirePlumber pre-link policy and native ingress capture passed self-test",
          sourceFormat: {
            sampleRate: result.sampleRate,
            channels: result.channels,
            sampleFormat: result.sampleFormat,
          },
        };
      } catch (error) {
        return {
          ready: false,
          code: "linux_capture_helper_failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    })();
    this.probeInFlight = probe;
    try {
      const result = await probe;
      this.cachedProbe = { at: this.clock(), value: result };
      return result;
    } finally {
      if (this.probeInFlight === probe) this.probeInFlight = null;
    }
  }

  async resolveProcesses(settings) {
    return this.processResolver(settings);
  }

  async probe(settings) {
    const helper = await this.helperReadiness();
    if (!helper.ready) return helper;
    try {
      const processes = await this.resolveProcesses(settings);
      if (!Array.isArray(processes.pids) || processes.pids.length === 0) {
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
          ? `${settings.sourceName} is ready for native PipeWire process routing`
          : `${targetAppLabel(settings?.targetApp)} process scope is ready for native PipeWire routing`,
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
    const readiness = await this.probe(settings);
    if (!readiness.ready) throw new Error(readiness.detail);
    const helper = await this.helperReadiness();
    if (!helper.sourceFormat) throw new Error("PipeWire source format is unavailable");
    return { ...helper.sourceFormat };
  }

  async acquire(settings, onRouteError, onRouteStatus, { signal } = {}) {
    if (this.child) throw new Error("A Linux PipeWire process route is already acquired");
    if (this.unresolvedReleaseError) throw this.unresolvedReleaseError;
    if (typeof onRouteError !== "function") throw new Error("A route-liveness error handler is required");
    if (typeof onRouteStatus !== "function") throw new Error("A route-lifecycle status handler is required");
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("PipeWire route acquisition was cancelled");
    const readiness = await this.probe(settings);
    if (!readiness.ready) throw new Error(readiness.detail);
    const processes = await this.resolveProcesses(settings);
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("PipeWire route acquisition was cancelled");
    if (!Array.isArray(processes.pids) || processes.pids.length === 0) {
      throw new Error(`${settings?.sourceName || targetAppLabel(settings?.targetApp)} stopped before capture began`);
    }
    if (!SUPPORTED_ROUTE_IDS.includes(processes.routeId)) {
      throw new Error("The selected Linux source is not bound to a supported pre-linked route");
    }
    const args = ["--route", processes.routeId];
    const child = this.spawnProcess(this.helperPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.routeErrorHandler = onRouteError;
    this.routeStatusHandler = onRouteStatus;
    this.ready = null;
    this.routeState = null;
    this.expectedSequence = null;
    this.suppressionUncertain = false;
    this.releaseFailure = null;
    this.closing = false;

    await new Promise((resolve, reject) => {
      let settled = false;
      let stderr = "";
      let abortHandler = null;
      const timeout = setTimeout(() => finish(new Error("Native PipeWire route did not become armed")), 10_000);
      timeout.unref?.();
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (abortHandler) signal?.removeEventListener("abort", abortHandler);
        if (error) reject(error);
        else resolve(value);
      };
      abortHandler = () => finish(signal.reason instanceof Error ? signal.reason : new Error("PipeWire route acquisition was cancelled"));
      signal?.addEventListener("abort", abortHandler, { once: true });
      const parser = new NativeFrameParser((message) => {
        if (message.type === "ready") {
          if (this.ready || message.helper !== "capture" || message.protocolVersion !== 1 ||
              message.supportsArming !== true || message.supportsDeferredRoute !== true ||
              message.supportsCaptureProof !== true || message.supportsProcessScopedRouting !== true ||
              message.supportsRollbackProof !== true || message.supportsPrelinkedIngress !== true ||
              message.supportsDynamicProcessStreams !== true || message.supportsCrashRecovery !== true ||
              message.policyVersion !== POLICY_VERSION || message.routeOwner !== "wireplumber-prelink-policy" ||
              message.routeId !== processes.routeId ||
              message.armed !== true || message.state !== "armed" ||
              message.originalSuppressed !== false || message.tapActive !== false ||
              message.routeOwnershipVerified !== false ||
              message.activationSignal !== "owned_ingress_capture" ||
              message.sampleFormat !== "f32le") {
            const error = new Error("Capture helper did not prove an unmodified armed PipeWire graph");
            error.suppressionHeld = true;
            this.suppressionUncertain = true;
            finish(error);
            return;
          }
          this.ready = message;
          this.routeState = "armed";
          finish(null, message);
        } else if (message.type === "status") {
          const valid = (message.state === "armed" && message.originalSuppressed === false &&
              message.tapActive === false && message.captureVerified === false &&
              message.routeOwnershipVerified === false) ||
            (message.state === "engaged" && message.originalSuppressed === true &&
              message.tapActive === true && message.captureVerified === true &&
              message.routeOwnershipVerified === true && message.bypassMuteVerified === true &&
              message.prelinkPolicyVerified === true);
          if (!this.ready || !valid) {
            this.reportProtocolError(new Error("Capture helper emitted an invalid PipeWire route state"));
            return;
          }
          this.routeState = message.state;
          this.suppressionUncertain = false;
          this.expectedSequence = null;
          this.routeStatusHandler?.({ ...message });
        } else if (message.type === "audio") {
          if (!this.ready || !this.isSuppressed()) {
            this.reportProtocolError(new Error("PipeWire capture emitted PCM without proven route ownership"));
            return;
          }
          this.handleAudio(message);
        } else if (message.type === "error") {
          const error = new Error(message.message || "Native PipeWire capture failed");
          error.code = message.code || "linux_capture_failed";
          error.suppressionHeld = typeof message.suppressionHeld === "boolean" ? message.suppressionHeld : true;
          if (!settled) finish(error);
          else if (error.suppressionHeld) {
            this.suppressionUncertain = true;
            if (error.code === "route_disengage_failed") {
              this.unresolvedReleaseError ||= error;
              this.reportSuppressionUncertain(error);
            } else if (this.closing) this.releaseFailure ||= error;
            else this.reportStreamError(error);
          } else {
            this.reportRouteLoss(error);
          }
        }
      });
      child.stdout.on("data", (chunk) => {
        try { parser.push(chunk); }
        catch (error) {
          if (!settled) finish(error);
          else this.reportProtocolError(error);
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
        this.logger?.debug?.("native.pipewire_capture_stderr", { message: chunk.toString("utf8").trim() });
      });
      child.once("error", (error) => {
        if (!settled) finish(error);
        else this.reportProtocolError(error);
      });
      child.once("exit", (code, childSignal) => {
        const wasClosing = this.closing;
        const wasSuppressed = this.routeState === "engaged" || this.suppressionUncertain;
        this.ready = null;
        this.routeState = null;
        if (!settled) {
          finish(new Error(stderr.trim() || `PipeWire capture exited before readiness (code=${String(code)}, signal=${String(childSignal)})`));
        } else if (wasClosing && wasSuppressed && (code !== 0 || childSignal !== null)) {
          const error = new Error("PipeWire helper exit did not prove original topology restoration");
          error.code = "source_suppression_release_unproven";
          error.suppressionHeld = true;
          this.releaseFailure ||= error;
        } else if (!wasClosing && wasSuppressed) {
          const error = new Error("PipeWire capture exited before proving original topology restoration");
          error.code = "source_suppression_release_unproven";
          error.suppressionHeld = true;
          this.unresolvedReleaseError ||= error;
          this.reportSuppressionUncertain(error);
        } else if (!wasClosing) {
          const error = new Error(`Armed PipeWire capture exited unexpectedly (code=${String(code)}, signal=${String(childSignal)})`);
          error.suppressionHeld = false;
          this.reportRouteLoss(error);
        }
      });
    }).catch(async (error) => {
      this.closing = true;
      try { await this.terminateProcess(child); }
      catch (cleanupError) {
        this.suppressionUncertain = true;
        const failure = new Error(`PipeWire route acquisition failed and helper termination was not proven: ${cleanupError.message}`);
        failure.code = "source_suppression_acquire_cleanup_unproven";
        failure.suppressionHeld = true;
        failure.suppressionSession = this.createSessionGuard();
        throw failure;
      }
      if (this.child === child) this.child = null;
      this.closing = false;
      this.ready = null;
      this.routeState = null;
      this.routeErrorHandler = null;
      this.routeStatusHandler = null;
      this.suppressionUncertain = false;
      throw error;
    });
    this.routeStatusHandler({
      type: "status",
      state: "armed",
      reason: "route_acquired",
      originalSuppressed: false,
      tapActive: false,
      captureVerified: false,
      routeOwnershipVerified: false,
    });
    return this.createSessionGuard();
  }

  createSessionGuard() {
    const route = this;
    return {
      get armed() { return route.isArmed(); },
      get originalSuppressed() { return route.isSuppressed(); },
      get restorationUnproven() { return Boolean(route.unresolvedReleaseError || route.suppressionUncertain); },
      format: route.ready ? {
        sampleRate: route.ready.sampleRate,
        channels: route.ready.channels,
        sampleFormat: route.ready.sampleFormat,
      } : null,
      close: () => route.release(),
    };
  }

  open(_settings, onFrame, onError) {
    if (!this.isArmed()) throw new Error("PipeWire process route must be armed before capture opens");
    if (this.frameHandler) throw new Error("The PipeWire capture stream is already open");
    if (typeof onFrame !== "function" || typeof onError !== "function") throw new Error("Capture frame and error handlers are required");
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

  handleAudio(message) {
    if (!this.frameHandler) return;
    if (this.expectedSequence !== null && message.sequence !== this.expectedSequence) {
      this.reportStreamError(new Error(`PipeWire capture sequence gap: expected ${this.expectedSequence}, received ${message.sequence}`));
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

  reportStreamError(error) {
    this.frameHandler = null;
    const handler = this.errorHandler;
    this.errorHandler = null;
    if (handler) handler(error);
    else this.logger?.error?.("native.pipewire_capture_failed", { message: error.message });
  }

  reportProtocolError(error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    normalized.code ||= "native_capture_protocol_error";
    normalized.suppressionHeld = true;
    this.reportSuppressionUncertain(normalized);
  }

  reportSuppressionUncertain(error) {
    this.frameHandler = null;
    this.errorHandler = null;
    this.suppressionUncertain = true;
    const handler = this.routeErrorHandler;
    this.routeErrorHandler = null;
    if (handler) handler(error);
    else this.logger?.error?.("native.pipewire_route_uncertain", { message: error.message });
  }

  reportRouteLoss(error) {
    this.frameHandler = null;
    this.errorHandler = null;
    this.routeStatusHandler = null;
    this.ready = null;
    this.routeState = null;
    this.suppressionUncertain = false;
    error.code ||= "source_suppression_lost";
    error.suppressionHeld = false;
    const handler = this.routeErrorHandler;
    this.routeErrorHandler = null;
    if (handler) handler(error);
  }

  async release() {
    if (this.releasePromise) return this.releasePromise;
    const operation = this.releaseOnce();
    this.releasePromise = operation;
    try { return await operation; }
    finally { if (this.releasePromise === operation) this.releasePromise = null; }
  }

  async releaseOnce() {
    const child = this.child;
    const unresolvedAtStart = this.unresolvedReleaseError;
    this.frameHandler = null;
    this.errorHandler = null;
    this.expectedSequence = null;
    if (!child) {
      if (unresolvedAtStart) throw unresolvedAtStart;
      if (this.suppressionUncertain) {
        const error = new Error("PipeWire topology restoration remains unproven without a helper handle");
        error.code = "source_suppression_release_unproven";
        error.suppressionHeld = true;
        this.unresolvedReleaseError = error;
        throw error;
      }
      return;
    }
    const wasSuppressed = this.routeState === "engaged" || this.suppressionUncertain;
    this.releaseFailure = null;
    this.closing = true;
    await this.terminateProcess(child);
    if (this.child === child) this.child = null;
    this.closing = false;
    this.ready = null;
    this.routeState = null;
    this.routeErrorHandler = null;
    this.routeStatusHandler = null;
    const failure = unresolvedAtStart || this.releaseFailure;
    this.releaseFailure = null;
    if (failure) {
      if (wasSuppressed) this.unresolvedReleaseError = failure;
      throw failure;
    }
    this.suppressionUncertain = false;
  }
}

module.exports = {
  LinuxProcessRoute,
  PROBE_CACHE_MS,
  SUPPORTED_ROUTE_IDS,
  linuxRouteId,
  pipeWireIdentity,
  pipeWireProcessIds,
  readLinuxProcesses,
  resolveLinuxProcessTree,
};
