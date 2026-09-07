"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { validateOutputSmoke } = require("../scripts/test-native.cjs");

const profile = { prebufferMs: 400, startupDelayMs: 200 };
const ready = {
  type: "ready", helper: "output", supportsJitterBuffer: true, startsWhenQueueFull: true,
  startupPrebufferMs: 400, startupDelayMs: 200,
  memberDeviceUids: [], memberDeviceUidsVerified: true, isAggregateDevice: false,
};
const running = { type: "status", helper: "output", state: "running", underruns: 0 };
const rebuffering = {
  type: "status", helper: "output", state: "rebuffering", underruns: 1, targetBufferedMs: 400,
};

test("native capacity smoke accepts playback and recovery after tiny packets drain", () => {
  validateOutputSmoke([ready, running], profile);
  validateOutputSmoke([ready, running, rebuffering, { ...running, underruns: 1 }], profile);
});

test("native capacity smoke rejects incomplete playback, errors, and malformed reports", () => {
  for (const messages of [
    [], [ready], [ready, running, rebuffering],
    [ready, { type: "error", helper: "output", state: "running" }],
    [{ ...ready, startupDelayMs: 0 }, running],
    [{ ...ready, memberDeviceUidsVerified: false }, running],
    [ready, running, { ...rebuffering, underruns: 0 }, running],
    [ready, running, { ...rebuffering, targetBufferedMs: 500 }, running],
    [ready, { ...running, state: "unknown" }],
  ]) {
    assert.throws(() => validateOutputSmoke(messages, profile), /Output smoke test failed/);
  }
});
