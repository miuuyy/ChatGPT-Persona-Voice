"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { ChatterboxEngine } = require("../electron/chatterbox-engine.cjs");

const format = { sampleRate: 16000, channels: 1, sampleFormat: "f32le" };
const frame = () => ({ ...format, samplesPerChannel: 320, pcm: Buffer.alloc(1280) });
async function fixture(t, mode = "normal") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cpv-chatterbox-test-"));
  const referencePath = path.join(directory, "reference.wav");
  fs.writeFileSync(referencePath, "test-only-reference");
  fs.writeFileSync(path.join(directory, "s3gen.safetensors"), "test-only-checkpoint");
  const children = [];
  const engine = new ChatterboxEngine({
    pythonPath: process.execPath, weightsPath: directory, voiceCatalog: { resolve: () => ({
      id: "test", referencePath, referenceSha256: crypto.createHash("sha256").update(fs.readFileSync(referencePath)).digest("hex"),
    }) },
    platform: "darwin", arch: "arm64",
    spawnProcess: (_python, args, options) => {
      const child = spawn(process.execPath, [path.join(__dirname, "fixtures/chatterbox-worker.cjs"), ...args],
                          { ...options, env: { ...options.env, CPV_TEST_MODE: mode } });
      children.push(child);
      return child;
    },
  });
  t.after(async () => { try { await engine.shutdown(); } finally { fs.rmSync(directory, { recursive: true, force: true }); } });
  return { engine, children, session: await engine.prepare({ selectedVoiceId: "test" }, format) };
}

test("Chatterbox exchanges real child-pipe messages and emits bounded playback frames", async (t) => {
  const { engine, session, children } = await fixture(t);
  await session.prime();
  assert.deepEqual(await session.convert(frame()), []);
  const output = await session.convert(frame());
  const lockedStream = require("../engine/chatterbox/model-lock.json").stream;
  const initialMs = lockedStream.initialBlockMs || lockedStream.blockMs;
  assert.equal(output.length, initialMs / 20);
  assert.equal(output.reduce((n, f) => n + f.samplesPerChannel, 0), initialMs * 24);
  const steady = await session.convert(frame());
  assert.equal(steady.length, lockedStream.blockMs / 20);
  assert.equal(steady.reduce((n, f) => n + f.samplesPerChannel, 0), lockedStream.blockMs * 24);
  assert.equal(engine.diagnostics().blockMs, lockedStream.blockMs);
  assert.equal(output[0].sampleRate, 24000);
  assert.equal(output.at(-1).sequence, output.length - 1);
  assert.equal(steady[0].sequence, output.length);
  assert.equal(steady.at(-1).sequence, output.length + steady.length - 1);
  await session.reset();
  assert.deepEqual(await session.convert(frame()), []);
  assert.equal((await session.convert(frame()))[0].sequence, 0);
  await Promise.all([session.close(), session.close()]);
  assert.equal(children[0].exitCode, 0);
});

test("reset invalidates an in-flight conversion and rejects oversized source packets", async (t) => {
  const { session } = await fixture(t, "delayed");
  await session.convert(frame());
  const pending = session.convert(frame());
  await session.reset();
  assert.deepEqual(await pending, []);
  await assert.rejects(session.convert({ ...format, samplesPerChannel: 641, pcm: Buffer.alloc(641 * 4) }), /source format/);
  assert.deepEqual(await session.convert(frame()), []);
});

test("corrupt model PCM fails closed and terminates the child", async (t) => {
  const { session, children } = await fixture(t, "corrupt");
  await assert.rejects(session.convert(frame()), /non-finite PCM/);
  await session.close();
  assert.ok(children[0].exitCode !== null || children[0].signalCode !== null);
});
