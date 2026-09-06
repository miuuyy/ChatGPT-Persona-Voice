"use strict";

// Explicit developer diagnostic: records a pair of source-application
// output and converted output locally. The ordinary app never records raw PCM.
// Stop the app relay before invoking this command. No microphone is captured.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { VoiceCatalog } = require("../electron/voice-catalog.cjs");
const { ChatterboxEngine } = require("../electron/chatterbox-engine.cjs");
const { resolveChatterboxPaths } = require("../electron/chatterbox-runtime.cjs");
const { MacProcessRoute } = require("../electron/macos-process-route.cjs");
const { MacAudioOutput } = require("../electron/macos-audio-output.cjs");
const { createRuntimeAdapters } = require("../electron/runtime-adapters.cjs");
const { PipelineRuntime } = require("../electron/pipeline-runtime.cjs");
const { spawn } = require("node:child_process");
const { createStateStore } = require("../electron/state-store.cjs");

const root = path.resolve(__dirname, "..");
async function record({ outputDirectory, seconds = 20, idleTimeoutMs = 120000, continuous = false }) {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This diagnostic requires Apple Silicon macOS");
  if (typeof continuous !== "boolean" || !path.isAbsolute(outputDirectory) ||
      !Number.isFinite(seconds) || seconds < 5 || seconds > 30) {
    throw new Error("An absolute unused output directory and 5–30 second capture bound are required");
  }
  fs.mkdirSync(outputDirectory, { mode: 0o700 });
  const data = path.join(os.homedir(), "Library/Application Support/Codex Persona Voice");
  const settings = createStateStore(path.join(data, "launcher-state.json")).read().settings;
  if (settings.selectedModelId !== "chatterbox") throw new Error("Select Chatterbox D before running this diagnostic");
  const catalog = new VoiceCatalog({ manifestPath: path.join(root, "voices/manifest.json"),
    additionalManifestPaths: [path.join(data, "voices/manifest.json")] });
  const engine = new ChatterboxEngine({ paths: resolveChatterboxPaths(), voiceCatalog: catalog });
  // Spool PCM and events directly to disk: waiting or recording for hours must
  // not accumulate audio or a growing event array in the Node process.
  const descriptors = new Map();
  const append = (name, bytes) => {
    if (!descriptors.has(name)) descriptors.set(name, fs.openSync(path.join(outputDirectory, name), "wx", 0o600));
    const fd = descriptors.get(name);
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      if (!written) throw new Error("Diagnostic recording could not write to disk");
      offset += written;
    }
  };
  let inputFormat = null, outputFormat = null, inputSamples = 0, outputSamples = 0;
  const log = (event, detail) => append("events.jsonl", Buffer.from(JSON.stringify({
    at: performance.now(), event, detail, inputSamples, outputSamples,
  }) + "\n"));
  const saveStatus = (status) => fs.writeFileSync(path.join(outputDirectory, "recording.json"), JSON.stringify({
    pid: process.pid, status, continuous, inputFormat, outputFormat, inputSamples, outputSamples,
  }, null, 2), { mode: 0o600 });
  saveStatus("starting");
  const logger = { info: log, debug: log, warn: log };
  const route = new MacProcessRoute({ helperPath: path.join(root, "native/bin/darwin/cpv-audio-capture"), logger });
  const sink = new MacAudioOutput({ helperPath: path.join(root, "native/bin/darwin/cpv-audio-output"), logger,
    startupPrebufferMs: 400, startupDelayMs: 200 });
  const config = { ...settings, recordingBusEnabled: false };
  const adapters = createRuntimeAdapters({}, () => config, { processRoute: route, audioOutput: sink, voiceEngine: engine });
  let done;
  const capture = new Promise((resolve) => { done = resolve; });
  const source = {
    ...adapters.source,
    open: (options, onFrame, onError) => adapters.source.open(options, (frame) => {
      // Capture exactly the frames the real pipeline accepts. Suppression proof
      // can arrive during model priming, when enqueueFrame intentionally drops it.
      if (runtime.state !== "running") return;
      if (continuous || inputSamples < frame.sampleRate * seconds) {
        inputFormat = { sampleRate: frame.sampleRate, channels: frame.channels, sampleFormat: frame.sampleFormat };
        append("source.f32le", frame.pcm); inputSamples += frame.samplesPerChannel;
        onFrame(frame);
      }
      if (!continuous && inputSamples >= frame.sampleRate * seconds) done("capture_bound");
    }, onError),
  };
  const runtime = new PipelineRuntime({ ...adapters, source,
    onOutputFrame: (frame) => {
      outputFormat = { sampleRate: frame.sampleRate, channels: frame.channels, sampleFormat: frame.sampleFormat };
      append("converted.f32le", frame.pcm); outputSamples += frame.samplesPerChannel;
    },
  });
  let lastState = null;
  runtime.on("changed", (state) => {
    if (lastState !== state.state) { log("runtime", state); lastState = state.state; }
    if (state.state === "faulted") done("runtime_fault");
  });
  const interrupt = () => done("interrupted");
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  let timer, statusTimer, reason = null;
  try {
    const state = await runtime.start(config);
    if (state.state !== "armed") throw new Error("The diagnostic did not reach native standby");
    console.log(continuous
      ? "READY_FOR_VOICE: continuous local recording until SIGINT/SIGTERM; no idle or audio-duration timeout"
      : `READY_FOR_VOICE: recording up to ${seconds}s of application output locally; open voice mode now`);
    saveStatus("ready");
    statusTimer = setInterval(() => saveStatus(runtime.state), 5000);
    if (!continuous) timer = setTimeout(() => done("idle_timeout"), idleTimeoutMs);
    reason = await capture;
    await runtime.stop();
    if (!inputSamples || !outputSamples) throw new Error(`No source/output pair was received (${reason})`);
  } finally {
    clearTimeout(timer);
    clearInterval(statusTimer);
    await runtime.stop();
    await engine.shutdown();
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    for (const fd of descriptors.values()) fs.closeSync(fd);
    descriptors.clear();
    saveStatus("stopped");
    fs.writeFileSync(path.join(outputDirectory, "report.json"), JSON.stringify({
      scope: "Explicit local diagnostic of source-application output and Chatterbox D; source PCM is private",
      reason, continuous, inputFormat, outputFormat, inputSamples, outputSamples,
      eventsFile: "events.jsonl", final: runtime.snapshot(),
    }, null, 2), { mode: 0o600 });
  }
  // ffmpeg streams the file without loading the entire recording into memory.
  // RF64 handles recordings exceeding the ordinary WAV 4 GiB size limit.
  for (const [name, format, samples] of [["source", inputFormat, inputSamples], ["converted", outputFormat, outputSamples]]) {
    if (!samples) continue;
    await new Promise((resolve, reject) => {
      const child = spawn("ffmpeg", ["-v", "error", "-nostdin", "-n", "-f", "f32le",
        "-ar", String(format.sampleRate), "-ac", String(format.channels),
        "-i", path.join(outputDirectory, `${name}.f32le`), "-c:a", "pcm_s16le", "-rf64", "auto",
        path.join(outputDirectory, `${name}.wav`)], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (bytes) => { stderr = (stderr + bytes).slice(-4000); });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Diagnostic WAV export failed: ${stderr}`)));
    });
  }
  console.log(`PAIR_SAVED: ${outputDirectory}`);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (![2, 3].includes(args.length) || args[0] !== "--output" || (args.length === 3 && args[2] !== "--continuous")) {
    throw new Error("Usage: node scripts/record-live-comparison.cjs --output /absolute/unused/directory [--continuous]");
  }
  record({ outputDirectory: args[1], continuous: args[2] === "--continuous" }).catch((error) => { console.error(error); process.exitCode = 1; });
}
module.exports = { record };
