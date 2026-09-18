"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { ConvertedHistoryRecorder } = require("../electron/history-recorder.cjs");
const { encodePcm16Wav } = require("../electron/wav.cjs");

function audioFrame(value, {
  sampleRate = 8_000,
  channels = 1,
  samplesPerChannel = 800,
  itemId = null,
} = {}) {
  const pcm = Buffer.alloc(samplesPerChannel * channels * 4);
  for (let offset = 0; offset < pcm.length; offset += 4) pcm.writeFloatLE(value, offset);
  return {
    sequence: 1,
    itemId,
    sampleRate,
    channels,
    sampleFormat: "f32le",
    samplesPerChannel,
    pcm,
  };
}

test("WAV encoder converts bounded f32le samples to a valid PCM16 RIFF file", () => {
  const chunk = Buffer.alloc(4 * 4);
  [-2, -0.5, 0.5, 2].forEach((value, index) => chunk.writeFloatLE(value, index * 4));
  const wav = encodePcm16Wav({ chunks: [chunk], sampleRate: 8_000, channels: 1, samplesPerChannel: 4 });
  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 8_000);
  assert.equal(wav.readInt16LE(44), -32768);
  assert.equal(wav.readInt16LE(46), -16384);
  assert.equal(wav.readInt16LE(48), 16384);
  assert.equal(wav.readInt16LE(50), 32767);
});

function recorderFixture(overrides = {}) {
  const writes = [];
  const errors = [];
  const timers = [];
  const settings = {
    saveConvertedAudio: true,
    sourceMode: "desktop-application",
    targetApp: "chatgpt",
    sourceName: "ChatGPT",
    selectedVoiceName: "Authorized voice",
  };
  const recorder = new ConvertedHistoryRecorder({
    historyStore: {
      addWav: (entry) => {
        writes.push(entry);
        return { id: `entry-${writes.length}`, ...entry };
      },
    },
    getSettings: () => settings,
    onError: (error) => errors.push(error),
    clock: () => new Date("2026-08-08T10:00:00.000Z"),
    setTimer: (callback) => {
      const timer = { callback, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => {},
    ...overrides,
  });
  return { errors, recorder, settings, timers, writes };
}

test("history recorder preserves speech boundaries, stays inert when disabled, and isolates metadata faults", () => {
  const fixture = recorderFixture({ silenceSplitMs: 200 });
  fixture.recorder.accept(audioFrame(0.25));
  fixture.recorder.accept(audioFrame(0));
  fixture.recorder.accept(audioFrame(0.3));
  fixture.recorder.accept(audioFrame(0));
  fixture.recorder.accept(audioFrame(0));
  assert.equal(fixture.writes.length, 1);
  assert.equal(fixture.writes[0].durationMs, 300);
  assert.equal(fixture.writes[0].voiceName, "Authorized voice");
  assert.equal(fixture.writes[0].sourceName, "ChatGPT");
  assert.deepEqual(fixture.errors, []);
  const grokFixture = recorderFixture();
  grokFixture.settings.targetApp = "grok-bot";
  grokFixture.settings.sourceName = null;
  grokFixture.recorder.accept(audioFrame(0.25));
  grokFixture.recorder.flush();
  assert.equal(grokFixture.writes[0].sourceName, "Grok Bot");
  const boundaryFixture = recorderFixture();
  boundaryFixture.recorder.accept(audioFrame(0.2, { itemId: "first" }));
  boundaryFixture.recorder.accept(audioFrame(0.2, { itemId: "second" }));
  assert.equal(boundaryFixture.writes.length, 1);
  boundaryFixture.timers.at(-1).callback();
  assert.equal(boundaryFixture.writes.length, 2);

  const disabled = recorderFixture();
  disabled.settings.saveConvertedAudio = false;
  disabled.recorder.accept(audioFrame(0.4));
  disabled.recorder.flush();
  assert.deepEqual(disabled.writes, []);

  const invalidMetadata = recorderFixture();
  invalidMetadata.settings.selectedVoiceName = null;
  assert.doesNotThrow(() => invalidMetadata.recorder.accept(audioFrame(0.4)));
  assert.equal(invalidMetadata.errors.length, 1);
  assert.deepEqual(invalidMetadata.writes, []);
});
