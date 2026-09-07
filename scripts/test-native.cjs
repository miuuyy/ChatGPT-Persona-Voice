"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { NativeFrameParser, encodeAudioFrame } = require("../electron/native-protocol.cjs");

const PROJECT_ROOT = path.join(__dirname, "..");

function selfTest(executable, expectedHelper) {
  const result = spawnSync(executable, ["--self-test"], {
    encoding: null,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString("utf8") || `${expectedHelper} self-test exited with ${result.status}`);
  }
  const messages = [];
  const parser = new NativeFrameParser((message) => messages.push(message));
  parser.push(result.stdout);
  parser.finish();
  if (messages.length !== 1 || messages[0].type !== "ready" || messages[0].helper !== expectedHelper) {
    throw new Error(`${expectedHelper} returned an invalid native self-test response`);
  }
}

function smokeOutput(executable, { prebufferMs = 500, startupDelayMs = 0 } = {}) {
  const samplesPerChannel = 1;
  const frame = encodeAudioFrame({
    sequence: 0,
    sampleRate: 24_000,
    channels: 1,
    sampleFormat: "f32le",
    samplesPerChannel,
    pcm: Buffer.alloc(samplesPerChannel * Float32Array.BYTES_PER_ELEMENT),
  });
  const result = spawnSync(executable, ["--sample-rate", "24000", "--channels", "1",
    "--startup-prebuffer-ms", String(prebufferMs), "--startup-delay-ms", String(startupDelayMs)], {
    input: Buffer.concat(Array(65).fill(frame)),
    encoding: null,
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString("utf8") || `Output smoke test exited with ${result.status}`);
  }
  const messages = [];
  const parser = new NativeFrameParser((message) => messages.push(message));
  parser.push(result.stdout);
  parser.finish();
  validateOutputSmoke(messages, { prebufferMs, startupDelayMs });
}

function validateOutputSmoke(messages, { prebufferMs, startupDelayMs }) {
  // 64 single-sample packets play in 2.7 ms. The queue may legitimately drain
  // before the final packet arrives, so recovery is part of this capacity test.
  if (messages.length < 2 || messages[0].type !== "ready" || messages[0].helper !== "output" ||
      messages[0].supportsJitterBuffer !== true || messages[0].startsWhenQueueFull !== true ||
      messages[0].startupPrebufferMs !== prebufferMs || messages[0].startupDelayMs !== startupDelayMs || !Array.isArray(messages[0].memberDeviceUids) ||
      messages[0].memberDeviceUidsVerified !== true ||
      typeof messages[0].isAggregateDevice !== "boolean" ||
      messages.at(-1).state !== "running" ||
      messages.slice(1).some((message) => message.type !== "status" ||
        message.helper !== "output" || !Number.isInteger(message.underruns) || message.underruns < 0 ||
        (message.state !== "running" && !(message.state === "rebuffering" &&
          message.underruns > 0 && message.targetBufferedMs === prebufferMs)))) {
    throw new Error(`Output smoke test failed (prebuffer=${prebufferMs}, delay=${startupDelayMs}): ${JSON.stringify(messages)}`);
  }
}

function smokeAtomicSwap(executable) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpv-atomic-swap-"));
  try {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    fs.writeFileSync(path.join(first, "identity"), "first");
    fs.writeFileSync(path.join(second, "identity"), "second");
    const result = spawnSync(executable, [first, second], { encoding: "utf8", timeout: 5_000 });
    if (result.error) throw result.error;
    if (result.status !== 0 ||
        fs.readFileSync(path.join(first, "identity"), "utf8") !== "second" ||
        fs.readFileSync(path.join(second, "identity"), "utf8") !== "first") {
      throw new Error(result.stderr || "Atomic updater swap did not exchange both directories");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testNative(platform = process.platform) {
  if (platform === "linux") {
    return require("./linux-test-native.cjs").testLinuxNative(platform);
  }
  if (platform === "win32") {
    return require("./windows-test-native.cjs").testWindowsNative({ platform });
  }
  if (platform !== "darwin") throw new Error(`Native audio helper tests do not support ${platform}`);
  const capture = path.join(PROJECT_ROOT, "native/bin/darwin/cpv-audio-capture");
  const output = path.join(PROJECT_ROOT, "native/bin/darwin/cpv-audio-output");
  const atomicSwap = path.join(PROJECT_ROOT, "native/bin/darwin/cpv-atomic-swap");
  selfTest(capture, "capture");
  selfTest(output, "output");
  smokeOutput(output);
  smokeOutput(output, { prebufferMs: 400, startupDelayMs: 200 });
  for (const args of [["--startup-prebuffer-ms"], ["--startup-prebuffer-ms", "399"], ["--startup-delay-ms", "501"]]) {
    const result = spawnSync(output, ["--self-test", ...args], { timeout: 3000 });
    const messages = [];
    const parser = new NativeFrameParser((message) => messages.push(message));
    parser.push(result.stdout); parser.finish();
    if (result.status !== 1 || messages.length !== 1 || messages[0].type !== "error" || messages[0].code !== "invalid_arguments") {
      throw new Error("Output accepted an invalid playout-buffer setting");
    }
  }
  smokeAtomicSwap(atomicSwap);
  console.log("macOS capture, output, and atomic updater helper smoke tests passed.");
}

if (require.main === module) {
  try { testNative(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { selfTest, smokeAtomicSwap, smokeOutput, testNative, validateOutputSmoke };
