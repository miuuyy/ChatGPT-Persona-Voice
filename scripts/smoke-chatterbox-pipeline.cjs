"use strict";

// Real CPVE sidecar, live-paced source packets and the existing Core Audio sink.
// The sink receives silence unless --play is explicit; converted PCM is saved.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { ChatterboxEngine } = require("../electron/chatterbox-engine.cjs");
const { SeedVcEngine, resolveSeedVcPaths, STARTUP_DISCARD_MS } = require("../electron/seed-vc-engine.cjs");
const { MacAudioOutput } = require("../electron/macos-audio-output.cjs");
const { encodePcm16Wav } = require("../electron/wav.cjs");
const root = path.join(__dirname, "..");
const option = (name, defaultValue) => {
  const i = process.argv.indexOf(name);
  if (i === -1 && defaultValue === undefined) throw new Error(`Missing ${name}`);
  return i === -1 ? defaultValue : process.argv[i + 1];
};
const sourcePath = path.resolve(option("--source"));
const referencePath = path.resolve(option("--reference"));
const outputPath = path.resolve(option("--output"));
const engineName = option("--engine", "chatterbox");
if (!["chatterbox", "seed"].includes(engineName)) throw new Error("Unknown engine");
const sourceId = option("--source-id", path.basename(sourcePath, ".wav"));
const play = process.argv.includes("--play");
const format = { sampleRate: 48000, channels: 2, sampleFormat: "f32le" };
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  fs.mkdirSync(outputPath, { recursive: false });
  const decoded = spawnSync("ffmpeg", ["-v", "error", "-i", sourcePath, "-f", "f32le", "-ar", "48000", "-ac", "2", "pipe:1"], { maxBuffer: 128 * 1024 * 1024 });
  if (decoded.error || decoded.status !== 0 || decoded.stdout.length === 0) throw decoded.error || new Error(decoded.stderr.toString());
  const pcm = Buffer.concat([decoded.stdout, Buffer.alloc(48000 * 2 * 4 * 1.2)]);
  const voice = Object.freeze({ id: "local-comparison", name: "Local reference", referencePath, referenceSha256: hash(referencePath) });
  const voiceCatalog = { resolve: (id) => {
    if (id !== voice.id) throw new Error("The local comparison voice was not selected");
    return voice;
  } };
  let started = null, nativeError = null;
  const events = [], converted = [], conversionTrace = [];
  const record = (event, data) => {
    const atMs = started === null ? null : performance.now() - started;
    if (event === "engine.chatterbox_result" && data.samplesPerChannel === 0) return;
    events.push({ event, atMs, data });
  };
  const logger = { info: record, debug: record, warn: record };
  const engine = engineName === "chatterbox" ? new ChatterboxEngine({
    pythonPath: path.resolve(option("--python")), weightsPath: path.resolve(option("--weights")), voiceCatalog, logger,
  }) : new SeedVcEngine({ paths: resolveSeedVcPaths({ projectRoot: root }), voiceCatalog, logger });
  const prebufferMs = Number(option("--prebuffer-ms", "500"));
  const startupDelayMs = Number(option("--startup-delay-ms", "0"));
  const native = new MacAudioOutput({ helperPath: path.join(root, "native/bin/darwin/cpv-audio-output"), logger, startupPrebufferMs: prebufferMs, startupDelayMs });
  let session, sink;
  try {
    const preparedAt = performance.now();
    session = await engine.prepare({ selectedVoiceId: "local-comparison", selectedVoiceName: "Local reference" }, format);
    await session.prime();
    // Measure steady speech after the old engine's documented startup discard.
    // Report this separately; it is not suppressed in the product adapter.
    if (engineName === "seed") {
      for (let ms = 0; ms < STARTUP_DISCARD_MS; ms += 20) {
        const output = await session.convert({ ...format, sequence: ms / 20, samplesPerChannel: 960, pcm: Buffer.alloc(7680) });
        if (output.length) throw new Error("Seed startup discard produced output");
      }
    }
    const prepareMs = performance.now() - preparedAt;
    sink = await native.prepare({}, session.outputFormat, (error) => { nativeError = error; });
    started = performance.now();
    let sequence = 0, maxPacketLatenessMs = 0;
    const write = async (frames) => {
      for (const frame of frames) {
        converted.push(frame.pcm);
        await sink.write(play ? frame : { ...frame, pcm: Buffer.alloc(frame.pcm.length) });
      }
    };
    for (let offset = 0; offset < pcm.length; offset += 7680) {
      const bytes = pcm.subarray(offset, offset + 7680);
      const deadline = started + (offset + bytes.length) / (48000 * 2 * 4) * 1000;
      const wait = deadline - performance.now();
      if (wait > 0) await sleep(wait);
      maxPacketLatenessMs = Math.max(maxPacketLatenessMs, performance.now() - deadline);
      const before = performance.now();
      const frames = await session.convert({ ...format, sequence: sequence++, samplesPerChannel: bytes.length / 8, pcm: bytes });
      if (frames.length) conversionTrace.push({ readyMs: performance.now() - started, inputEndMs: (offset + bytes.length) / 384,
                                               computeMs: performance.now() - before, outputSamples: frames.reduce((n, f) => n + f.samplesPerChannel, 0) });
      await write(frames);
      if (nativeError) throw nativeError;
    }
    if (session.finish) await write(await session.finish());
    const streamMs = performance.now() - started;
    await sink.close(); sink = null;
    if (nativeError) throw nativeError;
    const output = "converted.wav";
    const outputSamples = converted.reduce((n, b) => n + b.length / 4, 0);
    fs.writeFileSync(path.join(outputPath, output), encodePcm16Wav({ chunks: converted, ...session.outputFormat, samplesPerChannel: outputSamples }));
    const startedEvent = events.find((e) => e.event === "native.output_buffered");
    if (!startedEvent) throw new Error("Core Audio did not report queue startup");
    const underruns = events.filter((e) => e.event === "native.output_rebuffering").length;
    const report = {
      scope: "Live-paced 48 kHz stereo source -> real CPVE worker -> Core Audio queue; excludes OS source capture and hardware output latency",
      engine: engineName, nativePlayback: play ? "converted audio" : "silence with identical frame sizes and timing",
      sourcePath, sourceSha256: hash(sourcePath), sourceSeconds: decoded.stdout.length / 384000,
      referenceSha256: hash(referencePath), prepareMs, prebufferMs, startupDelayMs,
      implementation: {
        workerSha256: hash(path.join(root, `engine/${engineName === "seed" ? "seed-vc" : "chatterbox"}/worker.py`)),
        nativeOutputSha256: hash(path.join(root, "native/bin/darwin/cpv-audio-output")),
        ...(engineName === "chatterbox" ? { lock: JSON.parse(fs.readFileSync(path.join(root, "engine/chatterbox/model-lock.json"))) } : {}),
      },
      startupDiscardBeforeMeasurementMs: engineName === "seed" ? STARTUP_DISCARD_MS : 0,
      tailSilenceSeconds: 1.2, streamMs, maxPacketLatenessMs,
      cases: [{ sourceId, profile: engineName, output, outputSha256: hash(path.join(outputPath, output)),
                outputSeconds: outputSamples / session.outputFormat.sampleRate,
                firstOutputMs: conversionTrace[0].readyMs, firstNativeQueueStartMs: startedEvent.atMs, underruns }],
      conversionTrace, events,
    };
    fs.writeFileSync(path.join(outputPath, "report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ engine: engineName, prepareMs, ...report.cases[0], maxPacketLatenessMs }));
    if (underruns) throw new Error(`Native playback rebuffered ${underruns} times`);
  } finally {
    try { await sink?.close(); }
    finally { try { await session?.close(); } finally { await engine.shutdown(); } }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
