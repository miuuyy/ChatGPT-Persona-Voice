"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const test = require("node:test");
const { probeNativeHelper, resolveNativeHelperPath } = require("../electron/native-helper.cjs");
const { encodeFrame } = require("../electron/native-protocol.cjs");

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    child.signalCode = signal;
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  };
  return child;
}

test("native helper probe accepts one versioned readiness frame", async () => {
  const child = fakeChild();
  let spawnedArguments = null;
  const probing = probeNativeHelper("/helper", "capture", {
    spawnProcess: (_executable, args) => {
      spawnedArguments = args;
      return child;
    },
    timeoutMs: 100,
    args: ["--self-test", "--device-uid", "device-1"],
  });
  child.stdout.emit("data", encodeFrame("ready", Buffer.from(JSON.stringify({
    type: "ready",
    helper: "capture",
    protocolVersion: 1,
  }))));
  child.exitCode = 0;
  child.emit("exit", 0, null);
  child.stdout.emit("end");
  child.emit("close", 0, null);
  assert.equal((await probing).helper, "capture");
  assert.deepEqual(spawnedArguments, ["--self-test", "--device-uid", "device-1"]);
  assert.deepEqual(child.kills, []);
});

test("native helper probe waits for stdout to drain after process exit", async () => {
  const child = fakeChild();
  const frame = encodeFrame("ready", Buffer.from(JSON.stringify({
    type: "ready",
    helper: "route",
    protocolVersion: 1,
  })));
  const probing = probeNativeHelper("/helper", "route", {
    spawnProcess: () => child,
    timeoutMs: 100,
  });
  const outcome = probing.then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error }),
  );

  child.exitCode = 0;
  child.emit("exit", 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.emit("data", frame.subarray(0, 7));
  child.stdout.emit("data", frame.subarray(7));
  child.stdout.emit("end");
  child.emit("close", 0, null);

  const result = await outcome;
  assert.equal(result.status, "fulfilled", result.error?.message);
  assert.equal(result.value.helper, "route");
  assert.deepEqual(child.kills, []);
});

test("native helper probe kills a malformed self-test process", async () => {
  const child = fakeChild();
  const probing = probeNativeHelper("/helper", "capture", {
    spawnProcess: () => child,
    timeoutMs: 100,
  });
  const malformedHeader = Buffer.alloc(12);
  malformedHeader.writeUInt16LE(1, 4);
  malformedHeader.writeUInt16LE(1, 6);
  child.stdout.emit("data", malformedHeader);
  await assert.rejects(() => probing, /magic does not match/);
  assert.deepEqual(child.kills, ["SIGKILL"]);
});

test("native helper paths distinguish development and packaged layouts", () => {
  assert.equal(resolveNativeHelperPath("capture", {
    platform: "darwin",
    projectRoot: "/project",
  }), path.join("/project", "native", "bin", "darwin", "cpv-audio-capture"));
  assert.equal(resolveNativeHelperPath("output", {
    platform: "darwin",
    isPackaged: true,
    resourcesPath: "/App/Contents/Resources",
  }), path.join("/App/Contents/Resources", "native", "darwin", "cpv-audio-output"));
  assert.equal(resolveNativeHelperPath("capture", {
    platform: "linux",
    projectRoot: "/project",
  }), path.join("/project", "native", "bin", "linux", "cpv-audio-capture"));
  assert.equal(resolveNativeHelperPath("output", {
    platform: "win32",
    projectRoot: "C:\\project",
  }), path.join("C:\\project", "native", "bin", "win32", "cpv-audio-output.exe"));
  assert.equal(resolveNativeHelperPath("route", {
    platform: "win32",
    isPackaged: true,
    resourcesPath: "C:\\Program Files\\Persona Voice\\resources",
  }), path.join("C:\\Program Files\\Persona Voice\\resources", "native", "win32", "cpv-audio-route.exe"));
  assert.equal(resolveNativeHelperPath("capture", { platform: "freebsd" }), null);
});
