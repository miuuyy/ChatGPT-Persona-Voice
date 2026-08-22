"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const test = require("node:test");
const {
  probeNativeHelper,
  resolveNativeHelperPath,
  terminateChild,
  waitForExit,
} = require("../electron/native-helper.cjs");
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

test("native helper exit and termination helpers preserve process-exit proof", async () => {
  const exiting = fakeChild();
  const waiting = waitForExit(exiting, 100);
  exiting.exitCode = 0;
  exiting.emit("exit", 0, null);
  assert.deepEqual(await waiting, { code: 0, signal: null });

  const terminating = fakeChild();
  await terminateChild(terminating, 100);
  assert.deepEqual(terminating.kills, ["SIGTERM"]);

  await terminateChild(null, 100);
  await terminateChild(exiting, 100);
});

test("native helper exit waiting rejects process errors and bounded timeouts", async () => {
  const errored = fakeChild();
  const erroredWait = waitForExit(errored, 100);
  errored.emit("error", new Error("spawn failed"));
  await assert.rejects(() => erroredWait, /spawn failed/);

  const stalled = fakeChild();
  await assert.rejects(() => waitForExit(stalled, 10), /did not exit within 10 ms/);
});

test("native helper termination escalates after a bounded graceful timeout", async () => {
  const child = fakeChild();
  child.kill = (signal) => {
    child.kills.push(signal);
    if (signal === "SIGKILL") {
      child.signalCode = signal;
      queueMicrotask(() => child.emit("exit", null, signal));
    }
    return true;
  };
  await terminateChild(child, 10);
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
});

test("native helper probe preserves a framed native error", async () => {
  const child = fakeChild();
  const probing = probeNativeHelper("/helper", "route", {
    spawnProcess: () => child,
    timeoutMs: 100,
  });
  child.stdout.emit("data", encodeFrame("error", Buffer.from(JSON.stringify({
    type: "error",
    helper: "route",
    message: "VB-CABLE identity could not be proven",
  }))));
  await assert.rejects(() => probing, /identity could not be proven/);
  assert.deepEqual(child.kills, ["SIGKILL"]);
});

test("native helper probe supplies a fallback for an empty native error", async () => {
  const child = fakeChild();
  const probing = probeNativeHelper("/helper", "route", {
    spawnProcess: () => child,
    timeoutMs: 100,
  });
  child.stdout.emit("data", encodeFrame("error", Buffer.from(JSON.stringify({
    type: "error",
    helper: "route",
  }))));
  await assert.rejects(() => probing, /route native self-test failed/);
});

test("native helper probe reports drained stderr when readiness is missing", async () => {
  const child = fakeChild();
  const probing = probeNativeHelper("/helper", "route", {
    spawnProcess: () => child,
    timeoutMs: 100,
  });
  child.stderr.emit("data", Buffer.from("driver self-test detail"));
  child.exitCode = 0;
  child.stdout.emit("end");
  child.emit("close", 0, null);
  await assert.rejects(() => probing, /driver self-test detail/);
  assert.deepEqual(child.kills, []);
});

test("native helper probe reports the final exit code when no frame is emitted", async () => {
  const child = fakeChild();
  const probing = probeNativeHelper("/helper", "route", {
    spawnProcess: () => child,
    timeoutMs: 100,
  });
  child.exitCode = 3;
  child.stdout.emit("end");
  child.emit("close", 3, null);
  await assert.rejects(() => probing, /code=3, signal=null/);
  assert.deepEqual(child.kills, []);
});

test("native helper probe times out once and kills the live child", async () => {
  const child = fakeChild();
  const probing = probeNativeHelper("/helper", "route", {
    spawnProcess: () => child,
    timeoutMs: 10,
  });
  await assert.rejects(() => probing, /timed out/);
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
  assert.throws(() => resolveNativeHelperPath("unknown"), /Unknown native helper kind/);
});
