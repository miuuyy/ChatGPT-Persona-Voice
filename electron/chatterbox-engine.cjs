"use strict";

// Explicit streaming engine; no fallback or source-audio pass-through.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { EngineMessageParser, encodeEngineMessage } = require("./engine-protocol.cjs");
const { writeFrame } = require("./native-protocol.cjs");
const { terminateChild, waitForExit } = require("./native-helper.cjs");
const { resolveChatterboxPaths, inspectChatterboxRuntime } = require("./chatterbox-runtime.cjs");
const OUTPUT_FORMAT = Object.freeze({ sampleRate: 24000, channels: 1, sampleFormat: "f32le" });
const RESPONSE = Object.freeze({ convert: "result", finish: "finished", prime: "prime", reset: "reset", shutdown: "shutdown" });

class ChatterboxEngine {
  constructor({ pythonPath, weightsPath, voiceCatalog, logger = null, spawnProcess = spawn,
                platform = process.platform, arch = process.arch, paths = null, onDiagnostics = () => {} }) {
    this.paths = paths;
    this.assets = paths || resolveChatterboxPaths();
    pythonPath ??= paths?.pythonPath;
    weightsPath ??= paths?.weightsPath;
    if (!path.isAbsolute(pythonPath) || !path.isAbsolute(weightsPath)) {
      throw new Error("Chatterbox requires explicit absolute runtime and checkpoint paths");
    }
    this.pythonPath = pythonPath;
    this.weightsPath = weightsPath;
    this.voiceCatalog = voiceCatalog;
    this.logger = logger;
    this.spawnProcess = spawnProcess;
    this.platform = platform;
    this.arch = arch;
    this.session = null;
    this.preparing = false;
    this.onDiagnostics = onDiagnostics;
    this.convertedBlocks = 0;
    this.lastInferenceMs = null;
    this.voiceId = null;
    this.loadSeconds = null;
    this.healthy = false;
    this.streamSettings = null;
  }

  diagnostics() {
    const supported = this.platform === "darwin" && this.arch === "arm64";
    return {
      profile: "chatterbox-streaming", runtimeProfile: supported ? "darwin-arm64-mlx" : null,
      device: this.healthy ? "mlx" : null, backend: this.healthy ? "metal" : null,
      workerState: this.healthy ? "ready" : this.preparing ? "loading" : "stopped",
      active: this.healthy && Boolean(this.session), voiceId: this.healthy ? this.voiceId : null,
      steps: this.streamSettings?.steps ?? null, blockMs: this.streamSettings?.blockMs ?? null,
      startupDiscardMs: 0, convertedBlocks: this.convertedBlocks,
      loadSeconds: this.loadSeconds, warmupSeconds: null, torch: null, lastInferenceMs: this.lastInferenceMs,
      mpsCurrentAllocatedBytes: null, mpsDriverAllocatedBytes: null, mpsRecommendedMaxBytes: null,
      cudaAllocatedBytes: null, cudaReservedBytes: null, cudaDeviceName: null,
    };
  }
  publishDiagnostics() {
    try { this.onDiagnostics(this.diagnostics()); }
    catch (error) { this.logger?.warn?.("engine.diagnostics_publish_failed", { message: error.message }); }
  }

  async probe(settings) {
    try {
      if (this.platform !== "darwin" || this.arch !== "arm64") throw new Error("Chatterbox MLX requires Apple Silicon");
      if (this.paths) {
        const runtime = inspectChatterboxRuntime(this.paths, this.platform, this.arch);
        if (!runtime.ready) throw new Error(runtime.detail);
      }
      const voice = this.voiceCatalog.resolve(settings.selectedVoiceId);
      for (const file of [this.pythonPath, path.join(this.weightsPath, "s3gen.safetensors"), voice.referencePath]) {
        if (!fs.existsSync(file)) throw new Error(`Chatterbox input is missing: ${file}`);
      }
      return { label: "Voice engine", ready: true, code: "ready", detail: "Chatterbox · streaming · Apple MLX" };
    } catch (error) {
      return { label: "Voice engine", ready: false, code: "chatterbox_unavailable", detail: error.message };
    }
  }

  async prepare(settings, sourceFormat, { signal } = {}) {
    if (this.session || this.preparing) throw new Error("Chatterbox already has an active session");
    if (signal?.aborted) throw signal.reason || new Error("Chatterbox preparation was cancelled");
    if (sourceFormat?.sampleFormat !== "f32le" || ![1, 2].includes(sourceFormat.channels) ||
        !Number.isInteger(sourceFormat.sampleRate) || sourceFormat.sampleRate < 8000 || sourceFormat.sampleRate > 96000) {
      throw new Error("Chatterbox requires finite mono/stereo f32le PCM at 8000–96000 Hz");
    }
    this.preparing = true;
    this.publishDiagnostics();
    const preparationStart = performance.now();
    this.convertedBlocks = 0;
    this.lastInferenceMs = null;
    let child;
    try {
      const LOCK = JSON.parse(fs.readFileSync(this.assets.modelLockPath, "utf8"));
      this.streamSettings = Object.freeze({ ...LOCK.stream });
      const REQUIREMENTS_HASH = crypto.createHash("sha256").update(fs.readFileSync(this.assets.requirementsPath)).digest("hex");
      const OUTPUT_BLOCK_SAMPLES = LOCK.stream.blockMs * 24;
      const INITIAL_BLOCK_SAMPLES = (LOCK.stream.initialBlockMs || LOCK.stream.blockMs) * 24;
      const readiness = await this.probe(settings);
      if (!readiness.ready) throw new Error(readiness.detail);
      if (signal?.aborted) throw signal.reason || new Error("Chatterbox preparation was cancelled");
      const voice = this.voiceCatalog.resolve(settings.selectedVoiceId);
      if (fs.statSync(voice.referencePath).size > 16 * 1024 * 1024) throw new Error("Voice reference exceeds 16 MiB");
      const voiceHash = crypto.createHash("sha256").update(fs.readFileSync(voice.referencePath)).digest("hex");
      if (voice.referenceSha256 !== voiceHash) throw new Error("Voice reference no longer matches the catalog SHA-256");
      this.voiceId = voice.id;
      child = this.spawnProcess(this.pythonPath, [
        "-I",
        this.assets.workerPath,
        "--weights", this.weightsPath, "--voice", voice.referencePath, "--voice-sha256", voiceHash,
        "--source-rate", String(sourceFormat.sampleRate), "--source-channels", String(sourceFormat.channels),
      ], { stdio: ["pipe", "pipe", "pipe"], env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C", PYTHONUNBUFFERED: "1",
        PYTHONNOUSERSITE: "1", HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", PYTORCH_ENABLE_MPS_FALLBACK: "0",
      } });
      const pending = new Map();
      let ready = false, failure = null, closing = false, closed = false, converting = false;
      let nextId = 0, epoch = 0, sequence = 0, stderr = "", stopPromise = null;
      let closePromise = null;
      let expectInitialBlock = true;
      let resolveReady, rejectReady;
      const readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      const stop = () => { stopPromise ||= terminateChild(child); return stopPromise; };
      const fail = (error) => {
        if (failure) return;
        failure = error instanceof Error ? error : new Error(String(error));
        this.healthy = false;
        this.publishDiagnostics();
        rejectReady(failure);
        for (const request of pending.values()) { clearTimeout(request.timer); request.reject(failure); }
        pending.clear();
        void stop().catch(() => {});
      };
      const parser = new EngineMessageParser(({ header, body }) => {
        if (header.type === "error") throw new Error(header.message || "Chatterbox worker failed");
        if (header.type === "status") {
          if (ready || body.length || header.state !== "loading") throw new Error("Unexpected Chatterbox status");
          return;
        }
        if (header.type === "ready") {
          if (ready || body.length || header.protocolVersion !== 1 || header.engine !== "chatterbox" ||
              header.profile !== LOCK.profile || header.modelSha256 !== LOCK.model.files["s3gen.safetensors"] ||
              header.requirementsSha256 !== REQUIREMENTS_HASH ||
              header.voiceSha256 !== voiceHash || header.sourceRate !== sourceFormat.sampleRate || header.sourceChannels !== sourceFormat.channels ||
              Object.entries({ ...OUTPUT_FORMAT, ...LOCK.stream }).some(([key, value]) => header[key] !== value)) {
            throw new Error("Chatterbox Ready does not match the requested locked profile");
          }
          ready = true;
          resolveReady(header);
          return;
        }
        const request = pending.get(header.id);
        if (!ready || !request || header.type !== RESPONSE[request.type]) throw new Error("Uncorrelated Chatterbox response");
        if (request.type === "convert" || request.type === "finish") {
          const count = header.samplesPerChannel;
          if (Object.entries(OUTPUT_FORMAT).some(([key, value]) => header[key] !== value) ||
              !Number.isInteger(count) || count < 0 || count > 24000 || body.length !== count * 4 ||
              (request.type === "convert" && ![0, INITIAL_BLOCK_SAMPLES, OUTPUT_BLOCK_SAMPLES].includes(count))) {
            throw new Error("Chatterbox returned an invalid PCM result");
          }
          if (request.type === "convert" && count && request.epoch === epoch) {
            if (count !== (expectInitialBlock ? INITIAL_BLOCK_SAMPLES : OUTPUT_BLOCK_SAMPLES)) {
              throw new Error("Chatterbox changed its declared block sequence");
            }
            expectInitialBlock = false;
          }
          for (let offset = 0; offset < body.length; offset += 4) {
            if (!Number.isFinite(body.readFloatLE(offset))) throw new Error("Chatterbox returned non-finite PCM");
          }
        } else if (body.length) throw new Error("Chatterbox control response contains audio");
        if (request.type === "reset") expectInitialBlock = true;
        pending.delete(header.id);
        clearTimeout(request.timer);
        request.resolve({ header, body });
      });
      child.stdout.on("data", (bytes) => { try { parser.push(bytes); } catch (error) { fail(error); } });
      child.stderr.on("data", (bytes) => { stderr = (stderr + bytes.toString("utf8")).slice(-16384); });
      child.on("error", fail);
      child.stdin.on("error", fail);
      child.on("exit", (code) => {
        try { parser.finish(); } catch (error) { fail(error); }
        if (!closing || pending.size) fail(new Error(`Chatterbox exited (${code}): ${stderr.trim()}`));
      });
      const request = (type, body = Buffer.alloc(0)) => {
        if (!ready || failure || closed || (closing && type !== "shutdown")) return Promise.reject(failure || new Error("Chatterbox is closed"));
        if (pending.size >= 2) return Promise.reject(new Error("Chatterbox request queue is full"));
        return new Promise((resolve, reject) => {
          const id = ++nextId;
          const timer = setTimeout(() => fail(new Error(`Chatterbox ${type} timed out`)), 8000);
          timer.unref();
          pending.set(id, { type, timer, resolve, reject, epoch });
          writeFrame(child.stdin, encodeEngineMessage({ type, id }, body)).catch(fail);
        });
      };
      const onAbort = () => fail(signal.reason || new Error("Chatterbox preparation was cancelled"));
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => fail(new Error("Chatterbox readiness timed out")), 60000);
      timer.unref();
      try {
        if (signal?.aborted) onAbort();
        await readyPromise;
        this.healthy = true;
        this.loadSeconds = (performance.now() - preparationStart) / 1000;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
      const framesFrom = ({ header, body }, itemId = null) => {
        this.logger?.debug?.("engine.chatterbox_result", header);
        if (body.length) {
          this.convertedBlocks += 1;
          this.lastInferenceMs = Number.isFinite(header.elapsedMs) ? header.elapsedMs : null;
          this.publishDiagnostics();
        }
        const frames = [];
        for (let offset = 0; offset < body.length; offset += 480 * 4) {
          const pcm = Buffer.from(body.subarray(offset, offset + 480 * 4));
          frames.push({ ...OUTPUT_FORMAT, sequence: sequence++ >>> 0, itemId, samplesPerChannel: pcm.length / 4, pcm });
        }
        return frames;
      };
      const session = {
        outputFormat: { ...OUTPUT_FORMAT },
        prime: async () => (await request("prime")).header,
        convert: async (frame) => {
          if (converting) throw new Error("Concurrent Chatterbox converts are not allowed");
          if (Object.entries(sourceFormat).some(([key, value]) => frame?.[key] !== value) ||
              !Buffer.isBuffer(frame.pcm) || !Number.isInteger(frame.samplesPerChannel) || frame.samplesPerChannel <= 0 ||
              frame.samplesPerChannel > sourceFormat.sampleRate * 40 / 1000 ||
              frame.pcm.length !== frame.samplesPerChannel * sourceFormat.channels * 4) {
            throw new Error("Chatterbox input frame does not match its source format");
          }
          converting = true;
          const activeEpoch = epoch;
          try {
            const result = await request("convert", frame.pcm);
            return activeEpoch === epoch && !closing ? framesFrom(result, frame.itemId) : [];
          } finally { converting = false; }
        },
        finish: async () => {
          if (converting) throw new Error("Finish requires the last convert to complete");
          return framesFrom(await request("finish"));
        },
        reset: async () => { epoch += 1; await request("reset"); sequence = 0; },
        close: async () => {
          if (closed) return;
          if (closePromise) return closePromise;
          epoch += 1;
          closing = true;
          closePromise = (async () => {
            try {
              if (!failure) { await request("shutdown"); child.stdin.end(); await waitForExit(child, 5000); }
            } finally {
              await stop();
              closed = true;
              this.healthy = false;
              if (this.session === session) this.session = null;
              this.publishDiagnostics();
            }
          })();
          return closePromise;
        },
      };
      this.session = session;
      return session;
    } catch (error) {
      if (child) await terminateChild(child);
      throw error;
    } finally { this.preparing = false; this.publishDiagnostics(); }
  }

  async shutdown() { await this.session?.close(); }
}

module.exports = { ChatterboxEngine, OUTPUT_FORMAT };
