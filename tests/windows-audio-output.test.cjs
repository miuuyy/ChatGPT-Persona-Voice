"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { WindowsAudioOutput } = require("../electron/windows-audio-output.cjs");
const { NativeFrameParser, encodeFrame } = require("../electron/native-protocol.cjs");

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.stdin.on("finish", () => {
    child.exitCode = 0;
    queueMicrotask(() => child.emit("exit", 0, null));
  });
  child.kill = (signal = "SIGTERM") => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  };
  return child;
}

function nativeReady({
  name = "Speakers",
  suppressionSink = false,
  mode = "converted",
} = {}) {
  const bounds = mode === "passthrough"
    ? { startupPrebufferMs: 40, queueCapacityMs: 250 }
    : { startupPrebufferMs: 500, queueCapacityMs: 1_500 };
  return encodeFrame("ready", Buffer.from(JSON.stringify({
    type: "ready",
    helper: "output",
    protocolVersion: 1,
    backend: "wasapi-shared-render",
    sampleRate: 24_000,
    channels: 1,
    sampleFormat: "f32le",
    maximumFrameDurationMs: 80,
    supportsJitterBuffer: true,
    startsWhenQueueFull: true,
    mode,
    ...bounds,
    supportsPassthrough: true,
    passthroughSilenceOnInputGap: true,
    passthroughStartupPrebufferMs: 40,
    passthroughQueueCapacityMs: 250,
    bufferFrames: 480,
    deviceId: "physical-output-id",
    deviceName: name,
    suppressionSink,
    usesDefaultDevice: true,
  })));
}

function fixture(child = fakeChild(), probe = {}) {
  const spawns = [];
  const output = new WindowsAudioOutput({
    helperPath: "C:\\helpers\\cpv-audio-output.exe",
    platform: "win32",
    exists: () => true,
    probeHelper: async () => ({
      backend: "wasapi-shared-render",
      supportsJitterBuffer: true,
      startsWhenQueueFull: true,
      mode: "converted",
      startupPrebufferMs: 500,
      queueCapacityMs: 1_500,
      supportsPassthrough: true,
      passthroughSilenceOnInputGap: true,
      passthroughStartupPrebufferMs: 40,
      passthroughQueueCapacityMs: 250,
      deviceId: "physical-output-id",
      deviceName: "Speakers",
      suppressionSink: false,
      usesDefaultDevice: true,
      ...probe,
    }),
    spawnProcess: (executable, args) => {
      spawns.push({ executable, args });
      return child;
    },
  });
  return { child, output, spawns };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("Windows output writes CPV1 PCM only after bounded physical WASAPI readiness", async () => {
  const { child, output, spawns } = fixture();
  const preparing = output.prepare(
    {}, { sampleRate: 24_000, channels: 1, sampleFormat: "f32le" }, () => {},
  );
  await nextTurn();
  child.stdout.emit("data", nativeReady());
  const session = await preparing;
  assert.deepEqual(spawns[0].args, [
    "--sample-rate", "24000", "--channels", "1", "--mode", "converted",
  ]);

  const chunks = [];
  child.stdin.on("data", (chunk) => chunks.push(chunk));
  const pcm = Buffer.alloc(240 * 4, 7);
  await session.write({
    sequence: 0,
    sampleRate: 24_000,
    channels: 1,
    sampleFormat: "f32le",
    samplesPerChannel: 240,
    pcm,
  });
  const messages = [];
  const parser = new NativeFrameParser((message) => messages.push(message));
  parser.push(Buffer.concat(chunks));
  parser.finish();
  assert.equal(messages.length, 1);
  assert.deepEqual(Buffer.from(messages[0].pcm), pcm);
  await session.close();
});

test("Windows output rejects VB-CABLE as the physical listening endpoint", async () => {
  const { output } = fixture(fakeChild(), {
    deviceName: "CABLE Input (VB-Audio Virtual Cable)",
    suppressionSink: true,
  });
  const probe = await output.probe();
  assert.equal(probe.ready, false);
  assert.match(probe.detail, /bounded WASAPI/i);
});

test("Windows output rejects native readiness that loses the sink identity proof", async () => {
  const { child, output } = fixture();
  const preparing = output.prepare(
    {}, { sampleRate: 24_000, channels: 1, sampleFormat: "f32le" }, () => {},
  );
  await nextTurn();
  child.stdout.emit("data", nativeReady({ suppressionSink: true }));
  await assert.rejects(preparing, /invalid or unsafe readiness/);
});

test("Windows passthrough uses a dedicated low-latency bounded queue", async () => {
  const { child, output, spawns } = fixture();
  const preparing = output.prepare(
    { outputMode: "passthrough" },
    { sampleRate: 24_000, channels: 1, sampleFormat: "f32le" },
    () => {},
  );
  await nextTurn();
  child.stdout.emit("data", nativeReady({ mode: "passthrough" }));
  const session = await preparing;
  assert.equal(session.mode, "passthrough");
  assert.deepEqual(spawns[0].args, [
    "--sample-rate", "24000", "--channels", "1", "--mode", "passthrough",
  ]);
  await session.close();
});
