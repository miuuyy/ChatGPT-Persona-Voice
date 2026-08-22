"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { WindowsProcessRoute } = require("../electron/windows-process-route.cjs");
const { encodeAudioFrame, encodeFrame } = require("../electron/native-protocol.cjs");

function fakeChild({ graceful = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = graceful ? new PassThrough() : null;
  child.exitCode = null;
  child.signalCode = null;
  if (child.stdin) {
    child.stdin.on("finish", () => {
      child.exitCode = 0;
      queueMicrotask(() => child.emit("exit", 0, null));
    });
  }
  child.kill = (signal = "SIGTERM") => {
    child.exitCode = signal === "SIGTERM" ? 0 : null;
    child.signalCode = signal === "SIGTERM" ? null : signal;
    queueMicrotask(() => child.emit("exit", child.exitCode, child.signalCode));
    return true;
  };
  return child;
}

function routeReady(state = "armed") {
  const engaged = state === "engaged";
  return encodeFrame("ready", Buffer.from(JSON.stringify({
    type: "ready",
    helper: "route",
    protocolVersion: 1,
    backend: "windows-virtual-endpoint-verifier",
    virtualCableInstalled: true,
    virtualCableCount: 1,
    sinkName: "CABLE Input (VB-Audio Virtual Cable)",
    sinkIdentity: "vb-audio-vb-cable-input-v1",
    routeMutation: false,
    manualAssignmentRequired: true,
    restoreRequired: true,
    restoreMechanism: "manual-volume-mixer",
    standbyPassthroughRequired: true,
    supportsCurrentSessionMembershipProof: true,
    supportsEventDrivenMonitoring: true,
    notificationGuaranteesPreAudio: false,
    proofScope: "current-live-sessions",
    endpointId: "vb-cable-input-id",
    armed: true,
    state,
    originalSuppressed: engaged,
  })));
}

function captureReady() {
  return encodeFrame("ready", Buffer.from(JSON.stringify({
    type: "ready",
    helper: "capture",
    protocolVersion: 1,
    backend: "wasapi-process-loopback",
    rootPid: 10,
    sampleRate: 48_000,
    channels: 2,
    sampleFormat: "f32le",
    supportsProcessTreeCapture: true,
    supportsCaptureProof: true,
    supportsSuppression: false,
    suppressionBoundary: "owned-virtual-endpoint-required",
  })));
}

function routeStatus(state) {
  const engaged = state === "engaged";
  return encodeFrame("status", Buffer.from(JSON.stringify({
    type: "status",
    helper: "route",
    state,
    reason: engaged ? "target_session_isolated" : "target_session_ended",
    originalSuppressed: engaged,
    routeVerified: true,
  })));
}

function fixture() {
  const routeChild = fakeChild({ graceful: true });
  const captureChild = fakeChild();
  const spawns = [];
  const route = new WindowsProcessRoute({
    captureHelperPath: "C:\\helpers\\cpv-audio-capture.exe",
    routeHelperPath: "C:\\helpers\\cpv-audio-route.exe",
    platform: "win32",
    exists: () => true,
    processResolver: async () => ({ rootPids: [10], pids: [10, 11] }),
    defaultProcessResolver: async () => ({ rootPids: [10], pids: [10, 11] }),
    probeHelper: async (_path, helper) => helper === "capture" ? {
      backend: "wasapi-process-loopback",
      minimumWindowsBuild: 20_348,
      windowsBuild: 26_100,
      sampleRate: 48_000,
      channels: 2,
      sampleFormat: "f32le",
      supportsProcessTreeCapture: true,
      supportsCaptureProof: true,
      supportsSuppression: false,
      suppressionBoundary: "owned-virtual-endpoint-required",
    } : {
      backend: "windows-virtual-endpoint-verifier",
      routeMutation: false,
      manualAssignmentRequired: true,
      restoreRequired: true,
      restoreMechanism: "manual-volume-mixer",
      standbyPassthroughRequired: true,
      supportsCurrentSessionMembershipProof: true,
      supportsEventDrivenMonitoring: true,
      notificationGuaranteesPreAudio: false,
      proofScope: "current-live-sessions",
      virtualCableInstalled: true,
      virtualCableCount: 1,
      sinkName: "CABLE Input (VB-Audio Virtual Cable)",
      sinkIdentity: "vb-audio-vb-cable-input-v1",
      endpointId: "vb-cable-input-id",
    },
    spawnProcess: (executable, args) => {
      const child = spawns.length === 0 ? routeChild : captureChild;
      spawns.push({ executable, args, child });
      return child;
    },
  });
  return { route, routeChild, captureChild, spawns };
}

const settings = { sourceName: "ChatGPT" };
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

async function acquireFixture(value, state = "armed") {
  const statuses = [];
  const routeErrors = [];
  const acquiring = value.route.acquire(
    settings, (error) => routeErrors.push(error), (status) => statuses.push(status),
  );
  await nextTurn();
  value.routeChild.stdout.emit("data", routeReady(state));
  await nextTurn();
  value.captureChild.stdout.emit("data", captureReady());
  const guard = await acquiring;
  return { guard, statuses, routeErrors };
}

test("Windows route arms process-loopback only behind the verified VB-CABLE guard", async () => {
  const value = fixture();
  assert.equal((await value.route.probe(settings)).ready, true);
  assert.deepEqual(await value.route.describe(settings), {
    sampleRate: 48_000,
    channels: 2,
    sampleFormat: "f32le",
  });
  const { guard } = await acquireFixture(value);
  assert.deepEqual(value.spawns[0].args, [
    "--suppression-endpoint-id", "vb-cable-input-id", "--root-pid", "10",
  ]);
  assert.deepEqual(value.spawns[1].args, ["--root-pid", "10"]);
  assert.equal(guard.armed, true);
  assert.equal(guard.originalSuppressed, false);
  await guard.close();
});

test("Windows readiness asks for external VB-CABLE without accepting an unverified sink", async () => {
  const value = fixture();
  value.route.probeHelper = async (_path, helper) => helper === "capture" ? {
    backend: "wasapi-process-loopback",
    minimumWindowsBuild: 20_348,
    windowsBuild: 26_100,
    sampleRate: 48_000,
    channels: 2,
    sampleFormat: "f32le",
    supportsProcessTreeCapture: true,
    supportsCaptureProof: true,
    supportsSuppression: false,
    suppressionBoundary: "owned-virtual-endpoint-required",
  } : {
    backend: "windows-virtual-endpoint-verifier",
    routeMutation: false,
    manualAssignmentRequired: true,
    restoreRequired: true,
    restoreMechanism: "manual-volume-mixer",
    standbyPassthroughRequired: true,
    supportsCurrentSessionMembershipProof: true,
    supportsEventDrivenMonitoring: true,
    notificationGuaranteesPreAudio: false,
    proofScope: "current-live-sessions",
    virtualCableInstalled: false,
    virtualCableCount: 0,
    sinkName: "CABLE Input (VB-Audio Virtual Cable)",
    sinkIdentity: "vb-audio-vb-cable-input-v1",
  };
  const readiness = await value.route.helperReadiness();
  assert.equal(readiness.ready, false);
  assert.equal(readiness.code, "windows_vb_cable_required");
  assert.match(readiness.detail, /Install VB-CABLE/);

  value.route.cachedProbe = null;
  const originalProbe = value.route.probeHelper;
  value.route.probeHelper = async (helperPath, helper) => {
    const result = await originalProbe(helperPath, helper);
    return helper === "route"
      ? { ...result, virtualCableCount: 2 }
      : result;
  };
  const ambiguous = await value.route.helperReadiness();
  assert.equal(ambiguous.ready, false);
  assert.equal(ambiguous.code, "windows_vb_cable_ambiguous");
  assert.match(ambiguous.detail, /multiple base VB-CABLE Input endpoints/);
});

test("Windows route exposes PCM only while every live target session is isolated", async () => {
  const value = fixture();
  const { guard, statuses } = await acquireFixture(value);
  const frames = [];
  const streamErrors = [];
  value.route.open(settings, (frame) => frames.push(frame), (error) => streamErrors.push(error));

  value.routeChild.stdout.emit("data", routeStatus("engaged"));
  const pcm = Buffer.alloc(64 * 2 * 4, 3);
  value.captureChild.stdout.emit("data", encodeAudioFrame({
    sequence: 9,
    sampleRate: 48_000,
    channels: 2,
    samplesPerChannel: 64,
    pcm,
  }));
  assert.equal(guard.originalSuppressed, true);
  assert.equal(statuses.at(-1).state, "engaged");
  assert.equal(frames.length, 1);
  assert.deepEqual(Buffer.from(frames[0].pcm), pcm);
  assert.deepEqual(streamErrors, []);

  value.routeChild.stdout.emit("data", routeStatus("armed"));
  value.captureChild.stdout.emit("data", encodeAudioFrame({
    sequence: 10,
    sampleRate: 48_000,
    channels: 2,
    samplesPerChannel: 64,
    pcm,
  }));
  assert.equal(frames.length, 1);
  await guard.close();
});

test("Windows route starts a new sequence domain when capture ownership changes", async () => {
  const value = fixture();
  const { guard } = await acquireFixture(value, "engaged");
  const pcm = Buffer.alloc(64 * 2 * 4, 5);
  const emitAudio = (sequence) => value.captureChild.stdout.emit("data", encodeAudioFrame({
    sequence,
    sampleRate: 48_000,
    channels: 2,
    samplesPerChannel: 64,
    pcm,
  }));

  const firstFrames = [];
  const firstErrors = [];
  const firstStream = value.route.open(
    settings,
    (frame) => firstFrames.push(frame),
    (error) => firstErrors.push(error),
  );
  emitAudio(9);
  assert.deepEqual(firstFrames.map((frame) => frame.sequence), [9]);
  assert.deepEqual(firstErrors, []);
  await firstStream.close();

  emitAudio(10);
  emitAudio(11);

  const secondFrames = [];
  const secondErrors = [];
  const secondStream = value.route.open(
    settings,
    (frame) => secondFrames.push(frame),
    (error) => secondErrors.push(error),
  );
  emitAudio(12);
  assert.deepEqual(secondErrors.map((error) => error.message), []);
  assert.deepEqual(secondFrames.map((frame) => frame.sequence), [12]);

  emitAudio(14);
  assert.equal(secondErrors.length, 1);
  assert.match(secondErrors[0].message, /expected 13, received 14/);
  await secondStream.close();
  await guard.close();
});

test("Windows route faults explicitly when a target session appears off-sink", async () => {
  const value = fixture();
  const { guard, routeErrors } = await acquireFixture(value, "engaged");
  value.route.open(settings, () => {}, () => {});
  value.routeChild.stdout.emit("data", encodeFrame("error", Buffer.from(JSON.stringify({
    type: "error",
    code: "windows_target_route_lost",
    message: "target session moved to Speakers",
    suppressionHeld: false,
  }))));
  assert.equal(routeErrors.length, 1);
  assert.equal(routeErrors[0].code, "windows_target_route_lost");
  assert.equal(guard.originalSuppressed, false);
  await guard.close();
});

test("Windows acquire retains both live helpers when dual cleanup cannot be proven", async () => {
  const value = fixture();
  value.routeChild.stdin.removeAllListeners("finish");
  let cleanupAllowed = false;
  value.route.terminateProcess = async (child) => {
    if (!cleanupAllowed) throw new Error("termination blocked");
    child.exitCode = 0;
    child.signalCode = null;
    queueMicrotask(() => child.emit("exit", 0, null));
  };
  value.route.waitForChildExit = async (child) => {
    if (!cleanupAllowed) throw new Error("graceful exit blocked");
    child.exitCode = 0;
    child.signalCode = null;
    queueMicrotask(() => child.emit("exit", 0, null));
    return { code: 0, signal: null };
  };

  const acquiring = value.route.acquire(settings, () => {}, () => {});
  await nextTurn();
  value.routeChild.stdout.emit("data", routeReady("armed"));
  await nextTurn();
  value.captureChild.stdout.emit("data", encodeFrame("error", Buffer.from(JSON.stringify({
    type: "error",
    code: "capture_start_failed",
    message: "capture did not start",
  }))));

  let failure;
  try { await acquiring; }
  catch (error) { failure = error; }
  assert.equal(failure?.code, "windows_route_acquire_cleanup_unproven");
  assert.equal(failure?.suppressionHeld, true);
  assert.ok(failure?.suppressionSession);
  assert.equal(value.route.captureChild, value.captureChild);
  assert.equal(value.route.routeChild, value.routeChild);

  cleanupAllowed = true;
  await failure.suppressionSession.close();
  assert.equal(value.route.captureChild, null);
  assert.equal(value.route.routeChild, null);
});
