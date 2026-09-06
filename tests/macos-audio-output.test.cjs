"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { MacAudioOutput } = require("../electron/macos-audio-output.cjs");
const {
  NativeFrameParser,
  encodeAudioFrame,
  encodeFrame,
} = require("../electron/native-protocol.cjs");

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

function outputReady({
  deviceUid = "default-device",
  deviceName = "Default output",
  usesDefaultDevice = true,
  sampleRate = 24_000,
  memberDeviceUids = [],
  memberDeviceUidsVerified = true,
  isAggregateDevice = false,
  startupPrebufferMs = 500,
  startupDelayMs = 0,
} = {}) {
  return encodeFrame(
    "ready",
    Buffer.from(
      JSON.stringify({
        type: "ready",
        helper: "output",
        protocolVersion: 1,
        sampleRate,
        channels: 1,
        sampleFormat: "f32le",
        maximumFrameDurationMs: 40,
        queueCapacityFrames: 64,
        supportsJitterBuffer: true,
        startsWhenQueueFull: true,
        startupPrebufferMs,
        startupDelayMs,
        deviceUid,
        deviceName,
        usesDefaultDevice,
        memberDeviceUids,
        memberDeviceUidsVerified,
        isAggregateDevice,
      }),
    ),
  );
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("macOS output verifies a requested prebuffer and rejects stale helper readiness", async () => {
  const child = fakeChild();
  const ready = {
    supportsJitterBuffer: true, startsWhenQueueFull: true, startupPrebufferMs: 400, startupDelayMs: 200, queueCapacityFrames: 64,
    deviceUid: "default-device", deviceName: "Default output", usesDefaultDevice: true,
    memberDeviceUids: [], memberDeviceUidsVerified: true, isAggregateDevice: false,
  };
  const output = new MacAudioOutput({
    helperPath: "/helpers/output", platform: "darwin", exists: () => true, startupPrebufferMs: 400, startupDelayMs: 200,
    probeHelper: async (_file, _type, { args }) => {
      assert.deepEqual(args, ["--self-test", "--startup-prebuffer-ms", "400", "--startup-delay-ms", "200"]);
      return ready;
    },
    spawnProcess: (_file, args) => {
      assert.ok(args.includes("--startup-prebuffer-ms"));
      assert.ok(args.includes("400"));
      return child;
    },
  });
  const preparing = output.prepare({}, { sampleRate: 24000, channels: 1, sampleFormat: "f32le" }, () => {});
  await nextTurn();
  child.stdout.emit("data", outputReady({ startupPrebufferMs: 400, startupDelayMs: 200 }));
  await (await preparing).close();
  const stale = new MacAudioOutput({
    helperPath: "/helpers/output", platform: "darwin", exists: () => true, startupPrebufferMs: 400,
    probeHelper: async () => ({ ...ready, startupPrebufferMs: 500 }),
  });
  assert.equal((await stale.probe()).ready, false);
  const staleDelay = new MacAudioOutput({
    helperPath: "/helpers/output", platform: "darwin", exists: () => true, startupPrebufferMs: 400, startupDelayMs: 200,
    probeHelper: async () => ({ ...ready, startupDelayMs: 0 }),
  });
  assert.equal((await staleDelay.probe()).ready, false);
  assert.throws(() => new MacAudioOutput({ helperPath: "/helpers/output", startupPrebufferMs: 399 }), /multiple of 20/);
});

test("macOS output writes only format-matched framed PCM", async () => {
  {
    const child = fakeChild();
    const spawns = [];
    const output = new MacAudioOutput({
      helperPath: "/helpers/output",
      platform: "darwin",
      exists: () => true,
      probeHelper: async () => ({
        type: "ready",
        helper: "output",
        protocolVersion: 1,
        supportsJitterBuffer: true,
        startsWhenQueueFull: true,
        startupPrebufferMs: 500,
        startupDelayMs: 0,
        queueCapacityFrames: 64,
        deviceUid: "default-device",
        deviceName: "Default output",
        usesDefaultDevice: true,
        memberDeviceUids: [],
        memberDeviceUidsVerified: true,
        isAggregateDevice: false,
      }),
      spawnProcess: (executable, args) => {
        spawns.push({ executable, args });
        return child;
      },
    });
    const preparing = output.prepare(
      {},
      { sampleRate: 24_000, channels: 1, sampleFormat: "f32le" },
      () => {},
    );
    await nextTurn();
    child.stdout.emit("data", outputReady());
    const session = await preparing;
    assert.deepEqual(spawns[0].args, [
      "--sample-rate",
      "24000",
      "--channels",
      "1",
    ]);

    const chunks = [];
    child.stdin.on("data", (chunk) => chunks.push(chunk));
    const pcm = Buffer.alloc(480 * 4);
    await session.write({
      sequence: 1,
      sampleRate: 24_000,
      channels: 1,
      sampleFormat: "f32le",
      samplesPerChannel: 480,
      pcm,
    });
    const messages = [];
    const parser = new NativeFrameParser((message) => messages.push(message));
    parser.push(Buffer.concat(chunks));
    parser.finish();
    assert.equal(messages.length, 1);
    assert.deepEqual(Buffer.from(messages[0].pcm), pcm);
    await session.close();
  }

  {
    const child = fakeChild();
    const output = new MacAudioOutput({
      helperPath: "/helpers/output",
      platform: "darwin",
      exists: () => true,
      probeHelper: async () => ({
        supportsJitterBuffer: true,
        startsWhenQueueFull: true,
        startupPrebufferMs: 500,
        startupDelayMs: 0,
        queueCapacityFrames: 64,
        deviceUid: "default-device",
        deviceName: "Default output",
        usesDefaultDevice: true,
        memberDeviceUids: [],
        memberDeviceUidsVerified: true,
        isAggregateDevice: false,
      }),
      spawnProcess: () => child,
    });
    const preparing = output.prepare(
      {},
      { sampleRate: 24_000, channels: 1, sampleFormat: "f32le" },
      () => {},
    );
    await nextTurn();
    child.stdout.emit("data", outputReady());
    const session = await preparing;
    await assert.rejects(
      () =>
        session.write({
          sequence: 1,
          sampleRate: 48_000,
          channels: 1,
          sampleFormat: "f32le",
          samplesPerChannel: 480,
          pcm: Buffer.alloc(480 * 4),
        }),
      /does not match/,
    );
    await session.close();
  }
});

test("concurrent output probes share one native self-test", async () => {
  let probeCalls = 0;
  let releaseProbe;
  const output = new MacAudioOutput({
    helperPath: "/helpers/output",
    platform: "darwin",
    exists: () => true,
    probeHelper: async () => {
      probeCalls += 1;
      await new Promise((resolve) => {
        releaseProbe = resolve;
      });
      return {
        supportsJitterBuffer: true,
        startsWhenQueueFull: true,
        startupPrebufferMs: 500,
        startupDelayMs: 0,
        queueCapacityFrames: 64,
        deviceUid: "default-device",
        deviceName: "Default output",
        usesDefaultDevice: true,
        memberDeviceUids: [],
        memberDeviceUidsVerified: true,
        isAggregateDevice: false,
      };
    },
  });
  const first = output.probe();
  const second = output.probe();
  assert.equal(probeCalls, 1);
  releaseProbe();
  assert.deepEqual(await first, await second);
});

test("macOS output binds a requested recording device by stable UID", async () => {
  const child = fakeChild();
  const spawns = [];
  const probes = [];
  const output = new MacAudioOutput({
    helperPath: "/helpers/output",
    platform: "darwin",
    exists: () => true,
    probeHelper: async (_path, _kind, options) => {
      probes.push(options.args);
      return {
        supportsJitterBuffer: true,
        startsWhenQueueFull: true,
        startupPrebufferMs: 500,
        startupDelayMs: 0,
        queueCapacityFrames: 64,
        deviceUid: "BlackHole2ch_UID",
        deviceName: "BlackHole 2ch",
        usesDefaultDevice: false,
        memberDeviceUids: [],
        memberDeviceUidsVerified: true,
        isAggregateDevice: false,
      };
    },
    spawnProcess: (executable, args) => {
      spawns.push({ executable, args });
      return child;
    },
  });
  const preparing = output.prepare(
    { outputDeviceUid: "BlackHole2ch_UID" },
    { sampleRate: 24_000, channels: 1, sampleFormat: "f32le" },
    () => {},
  );
  await nextTurn();
  child.stdout.emit(
    "data",
    outputReady({
      deviceUid: "BlackHole2ch_UID",
      deviceName: "BlackHole 2ch",
      usesDefaultDevice: false,
    }),
  );
  const session = await preparing;
  assert.deepEqual(probes, [
    ["--self-test", "--device-uid", "BlackHole2ch_UID"],
  ]);
  assert.deepEqual(spawns[0].args, [
    "--sample-rate",
    "24000",
    "--channels",
    "1",
    "--device-uid",
    "BlackHole2ch_UID",
  ]);
  await session.close();
});

test("output lifecycle quiesces faults and retains failed cleanup for retry", async () => {
  {
    const child = fakeChild();
    const errors = [];
    const output = new MacAudioOutput({
      helperPath: "/helpers/output",
      platform: "darwin",
      exists: () => true,
      probeHelper: async () => ({
        supportsJitterBuffer: true,
        startsWhenQueueFull: true,
        startupPrebufferMs: 500,
        startupDelayMs: 0,
        queueCapacityFrames: 64,
        deviceUid: "default-device",
        deviceName: "Default output",
        usesDefaultDevice: true,
        memberDeviceUids: [],
        memberDeviceUidsVerified: true,
        isAggregateDevice: false,
      }),
      spawnProcess: () => child,
    });
    const preparing = output.prepare(
      {},
      { sampleRate: 24_000, channels: 1, sampleFormat: "f32le" },
      (error) => errors.push(error),
    );
    await nextTurn();
    child.stdout.emit("data", outputReady());
    const session = await preparing;
    child.exitCode = 1;
    child.emit("exit", 1, null);
    assert.equal(errors.length, 1);
    await session.close();
    await session.close();
  }

  {
    const child = fakeChild();
    child.stdin.removeAllListeners("finish");
    let terminationAttempts = 0;
    const output = new MacAudioOutput({
      helperPath: "/helpers/output",
      platform: "darwin",
      exists: () => true,
      probeHelper: async () => ({
        supportsJitterBuffer: true,
        startsWhenQueueFull: true,
        startupPrebufferMs: 500,
        startupDelayMs: 0,
        queueCapacityFrames: 64,
        deviceUid: "default-device",
        deviceName: "Default output",
        usesDefaultDevice: true,
        memberDeviceUids: [],
        memberDeviceUidsVerified: true,
        isAggregateDevice: false,
      }),
      spawnProcess: () => child,
      waitForChildExit: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        throw new Error("exit proof timed out");
      },
      terminateProcess: async () => {
        terminationAttempts += 1;
        if (terminationAttempts === 1)
          throw new Error("termination not proven");
        child.exitCode = 0;
        child.emit("exit", 0, null);
      },
    });
    const preparing = output.prepare(
      {},
      { sampleRate: 24_000, channels: 1, sampleFormat: "f32le" },
      () => {},
    );
    await nextTurn();
    child.stdout.emit("data", outputReady());
    const session = await preparing;

    await assert.rejects(() => session.close(), /termination not proven/);
    await session.close();
    assert.equal(terminationAttempts, 2);
  }

  {
    const child = fakeChild();
    child.stdin.removeAllListeners("finish");
    let terminationAttempts = 0;
    const output = new MacAudioOutput({
      helperPath: "/helpers/output",
      platform: "darwin",
      exists: () => true,
      probeHelper: async () => ({
        supportsJitterBuffer: true,
        startsWhenQueueFull: true,
        startupPrebufferMs: 500,
        startupDelayMs: 0,
        queueCapacityFrames: 64,
        deviceUid: "default-device",
        deviceName: "Default output",
        usesDefaultDevice: true,
        memberDeviceUids: [],
        memberDeviceUidsVerified: true,
        isAggregateDevice: false,
      }),
      spawnProcess: () => child,
      waitForChildExit: async () => {
        throw new Error("not exited");
      },
      terminateProcess: async () => {
        terminationAttempts += 1;
        if (terminationAttempts === 1)
          throw new Error("termination not proven");
        child.exitCode = 0;
        child.emit("exit", 0, null);
      },
    });
    const preparing = output.prepare(
      {},
      { sampleRate: 24_000, channels: 1, sampleFormat: "f32le" },
      () => {},
    );
    await nextTurn();
    child.stdout.emit("data", outputReady({ sampleRate: 44_100 }));
    await assert.rejects(async () => {
      try {
        await preparing;
      } catch (error) {
        assert.ok(error.outputSession);
        await error.outputSession.close();
        throw error;
      }
    }, /termination could not be proven/);
    assert.equal(terminationAttempts, 2);
  }

  {
    const child = fakeChild();
    const errors = [];
    const output = new MacAudioOutput({
      helperPath: "/helpers/output",
      platform: "darwin",
      exists: () => true,
      probeHelper: async () => ({
        supportsJitterBuffer: true,
        startsWhenQueueFull: true,
        startupPrebufferMs: 500,
        startupDelayMs: 0,
        queueCapacityFrames: 64,
        deviceUid: "default-device",
        deviceName: "Default output",
        usesDefaultDevice: true,
        memberDeviceUids: [],
        memberDeviceUidsVerified: true,
        isAggregateDevice: false,
      }),
      spawnProcess: () => child,
    });
    const preparing = output.prepare(
      {},
      { sampleRate: 24_000, channels: 1, sampleFormat: "f32le" },
      (error) => errors.push(error),
    );
    await nextTurn();
    child.stdout.emit("data", outputReady());
    const session = await preparing;
    child.stdout.emit(
      "data",
      encodeAudioFrame({
        sequence: 0,
        sampleRate: 24_000,
        channels: 1,
        samplesPerChannel: 1,
        pcm: Buffer.alloc(4),
      }),
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /unexpected audio frame/);
    await assert.rejects(
      () =>
        session.write({
          sequence: 1,
          sampleRate: 24_000,
          channels: 1,
          sampleFormat: "f32le",
          samplesPerChannel: 1,
          pcm: Buffer.alloc(4),
        }),
      /closed/,
    );
    await session.close();
  }
});
