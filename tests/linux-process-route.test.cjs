"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  LinuxProcessRoute,
  linuxRouteId,
  pipeWireIdentity,
  resolveLinuxProcessTree,
} = require("../electron/linux-process-route.cjs");
const { encodeAudioFrame, encodeFrame } = require("../electron/native-protocol.cjs");

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal = "SIGTERM") => {
    queueMicrotask(() => {
      child.exitCode = signal === "SIGTERM" ? 0 : null;
      child.signalCode = signal === "SIGTERM" ? null : signal;
      child.emit("exit", child.exitCode, child.signalCode);
    });
    return true;
  };
  return child;
}

function readyFrame(routeId = "chatgpt") {
  return encodeFrame("ready", Buffer.from(JSON.stringify({
    type: "ready",
    helper: "capture",
    protocolVersion: 1,
    source: "Linux PipeWire pre-linked ingress",
    sampleRate: 48_000,
    channels: 2,
    sampleFormat: "f32le",
    supportsArming: true,
    supportsDeferredRoute: true,
    supportsCaptureProof: true,
    supportsProcessScopedRouting: true,
    supportsRollbackProof: true,
    supportsPrelinkedIngress: true,
    supportsDynamicProcessStreams: true,
    supportsCrashRecovery: true,
    policyVersion: 3,
    routeOwner: "wireplumber-prelink-policy",
    routeId,
    supportedRouteIds: ["chatgpt", "codex", "grok-bot"],
    armed: true,
    state: "armed",
    originalSuppressed: false,
    tapActive: false,
    routeOwnershipVerified: false,
    activationSignal: "owned_ingress_capture",
  })));
}

function statusFrame(state) {
  const engaged = state === "engaged";
  return encodeFrame("status", Buffer.from(JSON.stringify({
    type: "status",
    helper: "capture",
    state,
    reason: engaged ? "process_route_isolated" : "route_restored",
    originalSuppressed: engaged,
    tapActive: engaged,
    captureVerified: engaged,
    routeOwnershipVerified: engaged,
    bypassMuteVerified: true,
    prelinkPolicyVerified: engaged,
  })));
}

function fixture(child = fakeChild()) {
  const spawns = [];
  const route = new LinuxProcessRoute({
    helperPath: "/helpers/capture",
    platform: "linux",
    exists: () => true,
    probeHelper: async () => ({
      helper: "capture",
      protocolVersion: 1,
      sampleRate: 48_000,
      channels: 2,
      sampleFormat: "f32le",
      supportsArming: true,
      supportsDeferredRoute: true,
      supportsCaptureProof: true,
      supportsProcessScopedRouting: true,
      supportsRollbackProof: true,
      supportsPrelinkedIngress: true,
      supportsDynamicProcessStreams: true,
      supportsCrashRecovery: true,
      policyVersion: 3,
      routeOwner: "wireplumber-prelink-policy",
      routeId: "chatgpt",
      supportedRouteIds: ["chatgpt", "codex", "grok-bot"],
      policyProbeVerified: true,
    }),
    processResolver: async () => ({ routeId: "chatgpt", rootPids: [10], pids: [10, 11, 12] }),
    spawnProcess: (executable, args) => {
      spawns.push({ executable, args });
      return child;
    },
  });
  return { child, route, spawns };
}

const settings = { sourceId: null, sourceName: "ChatGPT" };
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("Linux resolver scopes automatic selection to process descendants and excludes Persona", async () => {
  const processes = [
    { pid: 1, parentId: 0, executable: "/sbin/init", command: "/sbin/init" },
    { pid: 10, parentId: 1, executable: "/opt/ChatGPT/chatgpt", command: "/opt/ChatGPT/chatgpt" },
    { pid: 11, parentId: 10, executable: "/opt/ChatGPT/chrome", command: "renderer" },
    { pid: 20, parentId: 1, executable: "/persona/codex-persona-voice", command: "codex persona" },
    { pid: 21, parentId: 20, executable: "/persona/worker", command: "worker" },
  ];
  assert.deepEqual(await resolveLinuxProcessTree({}, { processes, ownProcessId: 20 }), {
    routeId: "chatgpt",
    rootPids: [10],
    pids: [10, 11],
  });
});

test("Linux automatic source selection rejects simultaneous ChatGPT and Codex identities", async () => {
  assert.equal(linuxRouteId("/opt/ChatGPT/chatgpt"), "chatgpt");
  assert.equal(linuxRouteId("/opt/Codex/codex"), "codex");
  assert.equal(linuxRouteId("/opt/Grok Bot/grok-bot"), "grok-bot");
  await assert.rejects(() => resolveLinuxProcessTree({}, {
    ownProcessId: 99,
    processes: [
      { pid: 10, parentId: 1, executable: "/opt/ChatGPT/chatgpt", command: "chatgpt" },
      { pid: 20, parentId: 1, executable: "/opt/Codex/codex", command: "codex" },
    ],
  }), /multiple ChatGPT/i);
});

test("Linux resolver selects the Grok Bot route without mixing ChatGPT processes", async () => {
  assert.deepEqual(await resolveLinuxProcessTree({ targetApp: "grok-bot" }, {
    ownProcessId: 99,
    processes: [
      { pid: 10, parentId: 1, executable: "/opt/ChatGPT/chatgpt", command: "chatgpt" },
      { pid: 20, parentId: 1, executable: "/opt/Grok Bot/grok-bot", command: "grok-bot" },
      { pid: 21, parentId: 20, executable: "/opt/Grok Bot/chrome", command: "renderer" },
    ],
  }), {
    routeId: "grok-bot",
    rootPids: [20],
    pids: [20, 21],
  });
});

test("Linux resolver decodes the existing PipeWire source identity contract", async () => {
  const identity = { application: "ChatGPT", binary: "chatgpt", node: "ChatGPT playback" };
  const sourceId = `pipewire:stream:${Buffer.from(JSON.stringify(identity)).toString("base64url")}`;
  assert.deepEqual(pipeWireIdentity(sourceId), identity);
  const objects = [
    { id: 5, type: "PipeWire:Interface:Client", info: { props: {
      "application.name": "ChatGPT", "application.process.binary": "chatgpt", "application.process.id": "10",
    } } },
    { id: 6, type: "PipeWire:Interface:Node", info: { props: {
      "client.id": "5", "media.class": "Stream/Output/Audio", "node.name": "ChatGPT playback",
    } } },
  ];
  const tree = await resolveLinuxProcessTree({ sourceId }, {
    processes: [
      { pid: 10, parentId: 1, executable: "/opt/chatgpt", command: "chatgpt" },
      { pid: 11, parentId: 10, executable: "/opt/renderer", command: "renderer" },
    ],
    ownProcessId: 99,
    run: async () => ({ stdout: JSON.stringify(objects) }),
  });
  assert.deepEqual(tree, { routeId: "chatgpt", rootPids: [10], pids: [10, 11] });
});

test("Linux route binds the macOS-compatible lifecycle to one pre-linked identity", async () => {
  const { child, route, spawns } = fixture();
  assert.equal((await route.probe(settings)).ready, true);
  assert.deepEqual(await route.describe(settings), {
    sampleRate: 48_000,
    channels: 2,
    sampleFormat: "f32le",
  });
  const statuses = [];
  const acquiring = route.acquire(settings, () => {}, (status) => statuses.push(status));
  await nextTurn();
  child.stdout.emit("data", readyFrame());
  const guard = await acquiring;
  assert.deepEqual(spawns[0].args, ["--route", "chatgpt"]);
  assert.equal(guard.armed, true);
  assert.equal(guard.originalSuppressed, false);
  assert.equal(statuses.at(-1).state, "armed");
  await guard.close();
});

test("Linux route exposes PCM only after native graph ownership is proven", async () => {
  const { child, route } = fixture();
  const statuses = [];
  const acquiring = route.acquire(settings, () => {}, (status) => statuses.push(status));
  await nextTurn();
  child.stdout.emit("data", readyFrame());
  const guard = await acquiring;
  const frames = [];
  const errors = [];
  route.open(settings, (frame) => frames.push(frame), (error) => errors.push(error));
  child.stdout.emit("data", statusFrame("engaged"));
  const pcm = Buffer.alloc(64 * 2 * 4);
  child.stdout.emit("data", encodeAudioFrame({
    sequence: 7,
    sampleRate: 48_000,
    channels: 2,
    samplesPerChannel: 64,
    pcm,
  }));
  assert.equal(guard.originalSuppressed, true);
  assert.equal(statuses.at(-1).routeOwnershipVerified, true);
  assert.equal(frames.length, 1);
  assert.deepEqual(Buffer.from(frames[0].pcm), pcm);
  assert.deepEqual(errors, []);
  child.stdout.emit("data", statusFrame("armed"));
  assert.equal(guard.originalSuppressed, false);
  await guard.close();
});

test("Linux route treats PCM before exclusive ownership as a route protocol fault", async () => {
  const { child, route } = fixture();
  const routeErrors = [];
  const acquiring = route.acquire(settings, (error) => routeErrors.push(error), () => {});
  await nextTurn();
  child.stdout.emit("data", readyFrame());
  const guard = await acquiring;
  route.open(settings, () => {}, () => {});
  child.stdout.emit("data", encodeAudioFrame({
    sequence: 0, sampleRate: 48_000, channels: 2, samplesPerChannel: 4, pcm: Buffer.alloc(32),
  }));
  assert.equal(routeErrors.length, 1);
  assert.equal(routeErrors[0].code, "native_capture_protocol_error");
  assert.equal(guard.restorationUnproven, true);
  await guard.close();
});

test("Linux route detects CPV1 sequence loss without releasing suppression early", async () => {
  const { child, route } = fixture();
  const acquiring = route.acquire(settings, () => {}, () => {});
  await nextTurn();
  child.stdout.emit("data", readyFrame());
  const guard = await acquiring;
  const streamErrors = [];
  route.open(settings, () => {}, (error) => streamErrors.push(error));
  child.stdout.emit("data", statusFrame("engaged"));
  for (const sequence of [1, 3]) {
    child.stdout.emit("data", encodeAudioFrame({
      sequence, sampleRate: 48_000, channels: 2, samplesPerChannel: 4, pcm: Buffer.alloc(32),
    }));
  }
  assert.equal(streamErrors.length, 1);
  assert.match(streamErrors[0].message, /sequence gap/);
  assert.equal(guard.originalSuppressed, true);
  await guard.close();
});

test("Linux helper rollback failure remains an explicit unresolved suppression blocker", async () => {
  const { child, route } = fixture();
  const acquiring = route.acquire(settings, () => {}, () => {});
  await nextTurn();
  child.stdout.emit("data", readyFrame());
  const guard = await acquiring;
  child.stdout.emit("data", statusFrame("engaged"));
  child.stdout.emit("data", encodeFrame("error", Buffer.from(JSON.stringify({
    type: "error",
    code: "route_disengage_failed",
    message: "An original endpoint disappeared",
    suppressionHeld: true,
  }))));
  assert.equal(guard.restorationUnproven, true);
  await assert.rejects(() => guard.close(), /topology restoration|endpoint disappeared/i);
});
