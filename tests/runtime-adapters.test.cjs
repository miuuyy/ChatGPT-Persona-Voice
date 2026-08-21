"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { OBS_RECORDING_DEVICE_UID, createRuntimeAdapters } = require("../electron/runtime-adapters.cjs");

test("platform audio setup blocks suppression readiness before a native route is owned", async () => {
  const settings = { sourceMode: "desktop-application", recordingBusEnabled: false };
  let routeProbeCalls = 0;
  const processRoute = {
    probe: async () => {
      routeProbeCalls += 1;
      return { ready: true, code: "ready", detail: "raw helper ready" };
    },
  };
  const adapters = createRuntimeAdapters({}, () => settings, {
    processRoute,
    getPlatformAudioSetup: () => ({
      status: "action-required",
      code: "windows_route_assignment_required",
      detail: "Assign ChatGPT to CABLE Input",
    }),
  });

  assert.deepEqual(await adapters.suppression.probe(), {
    label: "Original suppression",
    ready: false,
    code: "windows_route_assignment_required",
    detail: "Assign ChatGPT to CABLE Input",
  });
  assert.equal(routeProbeCalls, 0);
});

test("recording bus mirrors converted frames to BlackHole without replacing default playback", async () => {
  const settings = { sourceMode: "desktop-application", recordingBusEnabled: true };
  const probes = [];
  const writes = [];
  const closes = [];
  const macAudioOutput = {
    probe: async (deviceUid = null) => {
      probes.push(deviceUid);
      return {
        ready: true,
        code: "ready",
        detail: deviceUid || "default",
        deviceUid: deviceUid || "built-in-output",
        memberDeviceUids: [],
        memberDeviceUidsVerified: true,
        isAggregateDevice: false,
      };
    },
    prepare: async (config) => {
      const deviceUid = config.outputDeviceUid ?? null;
      return {
        deviceUid: deviceUid || "built-in-output",
        memberDeviceUids: [],
        memberDeviceUidsVerified: true,
        isAggregateDevice: false,
        write: async (frame) => { writes.push({ deviceUid, frame }); },
        close: async () => { closes.push(deviceUid); },
      };
    },
  };
  const adapters = createRuntimeAdapters({}, () => settings, {
    audioOutput: macAudioOutput,
    recordingBusDeviceUid: OBS_RECORDING_DEVICE_UID,
  });
  const readiness = await adapters.output.probe();
  assert.equal(readiness.ready, true);
  assert.deepEqual(probes, [null, OBS_RECORDING_DEVICE_UID]);

  const format = { sampleRate: 22_050, channels: 1, sampleFormat: "f32le" };
  const session = await adapters.output.prepare(settings, format, () => {});
  const frame = { sequence: 1 };
  await session.write(frame);
  assert.deepEqual(writes, [
    { deviceUid: null, frame },
    { deviceUid: OBS_RECORDING_DEVICE_UID, frame },
  ]);
  await session.close();
  assert.deepEqual(closes, [null, OBS_RECORDING_DEVICE_UID]);
});

test("recording bus fails closed when BlackHole is already the default output", async () => {
  const settings = { sourceMode: "desktop-application", recordingBusEnabled: true };
  let closes = 0;
  const macAudioOutput = {
    probe: async () => ({
      ready: true,
      code: "ready",
      detail: "BlackHole 2ch",
      deviceUid: OBS_RECORDING_DEVICE_UID,
      memberDeviceUids: [],
      memberDeviceUidsVerified: true,
      isAggregateDevice: false,
    }),
    prepare: async () => ({
      deviceUid: OBS_RECORDING_DEVICE_UID,
      memberDeviceUids: [],
      memberDeviceUidsVerified: true,
      isAggregateDevice: false,
      write: async () => {},
      close: async () => { closes += 1; },
    }),
  };
  const adapters = createRuntimeAdapters({}, () => settings, {
    audioOutput: macAudioOutput,
    recordingBusDeviceUid: OBS_RECORDING_DEVICE_UID,
  });
  const readiness = await adapters.output.probe();
  assert.equal(readiness.ready, false);
  assert.equal(readiness.code, "recording_bus_matches_default_output");
  await assert.rejects(
    () => adapters.output.prepare(
      settings,
      { sampleRate: 22_050, channels: 1, sampleFormat: "f32le" },
      () => {},
    ),
    /default output already includes BlackHole/,
  );
  assert.equal(closes, 1);
});

test("a failed partial output cleanup is returned to Pipeline for retry", async () => {
  const settings = { sourceMode: "desktop-application", recordingBusEnabled: true };
  const primary = {
    deviceUid: "built-in-output",
    memberDeviceUids: [],
    memberDeviceUidsVerified: true,
    isAggregateDevice: false,
    write: async () => {},
    close: async () => { throw new Error("primary still active"); },
  };
  let prepareCalls = 0;
  const macAudioOutput = {
    probe: async (deviceUid = null) => ({
      ready: true,
      code: "ready",
      detail: "ready",
      deviceUid: deviceUid || "built-in-output",
      memberDeviceUids: [],
      memberDeviceUidsVerified: true,
      isAggregateDevice: false,
    }),
    prepare: async () => {
      prepareCalls += 1;
      if (prepareCalls === 1) return primary;
      throw new Error("BlackHole disappeared");
    },
  };
  const adapters = createRuntimeAdapters({}, () => settings, {
    audioOutput: macAudioOutput,
    recordingBusDeviceUid: OBS_RECORDING_DEVICE_UID,
  });
  await assert.rejects(
    async () => {
      try {
        await adapters.output.prepare(
          settings,
          { sampleRate: 22_050, channels: 1, sampleFormat: "f32le" },
          () => {},
        );
      } catch (error) {
        assert.equal(error.outputSession, primary);
        throw error;
      }
    },
    /BlackHole disappeared.*primary output could not be closed/,
  );
});

test("dual output startup failure retains both helper sessions for cleanup retry", async () => {
  const settings = { sourceMode: "desktop-application", recordingBusEnabled: true };
  let primaryCloseAttempts = 0;
  let recordingCloseAttempts = 0;
  const primary = {
    deviceUid: "built-in-output",
    memberDeviceUids: [],
    memberDeviceUidsVerified: true,
    isAggregateDevice: false,
    write: async () => {},
    close: async () => {
      primaryCloseAttempts += 1;
      if (primaryCloseAttempts === 1) throw new Error("primary still active");
    },
  };
  const recordingRecovery = {
    write: async () => {},
    close: async () => { recordingCloseAttempts += 1; },
  };
  let prepareCalls = 0;
  const macAudioOutput = {
    probe: async (deviceUid = null) => ({
      ready: true,
      code: "ready",
      detail: "ready",
      deviceUid: deviceUid || "built-in-output",
      memberDeviceUids: [],
      memberDeviceUidsVerified: true,
      isAggregateDevice: false,
    }),
    prepare: async () => {
      prepareCalls += 1;
      if (prepareCalls === 1) return primary;
      const error = new Error("recording helper startup failed");
      error.outputSession = recordingRecovery;
      throw error;
    },
  };
  const adapters = createRuntimeAdapters({}, () => settings, {
    audioOutput: macAudioOutput,
    recordingBusDeviceUid: OBS_RECORDING_DEVICE_UID,
  });
  let retained;
  await assert.rejects(
    async () => {
      try {
        await adapters.output.prepare(
          settings,
          { sampleRate: 22_050, channels: 1, sampleFormat: "f32le" },
          () => {},
        );
      } catch (error) {
        retained = error.outputSession;
        throw error;
      }
    },
    /recording helper startup failed.*primary output could not be closed/,
  );
  assert.ok(retained);
  await retained.close();
  assert.equal(primaryCloseAttempts, 2);
  assert.equal(recordingCloseAttempts, 1);
});

test("a default Multi-Output Device containing BlackHole is rejected as a non-private recording bus", async () => {
  const settings = { sourceMode: "desktop-application", recordingBusEnabled: true };
  let prepareCalls = 0;
  const primary = {
    deviceUid: "aggregate-output",
    memberDeviceUids: ["built-in-output", OBS_RECORDING_DEVICE_UID],
    memberDeviceUidsVerified: true,
    isAggregateDevice: true,
    write: async () => {},
    close: async () => {},
  };
  const macAudioOutput = {
    probe: async (deviceUid = null) => deviceUid
      ? {
          ready: true,
          code: "ready",
          detail: "BlackHole",
          deviceUid,
          memberDeviceUids: [],
          memberDeviceUidsVerified: true,
          isAggregateDevice: false,
        }
      : {
          ready: true,
          code: "ready",
          detail: "Multi-Output Device",
          deviceUid: primary.deviceUid,
          memberDeviceUids: primary.memberDeviceUids,
          memberDeviceUidsVerified: true,
          isAggregateDevice: true,
        },
    prepare: async () => {
      prepareCalls += 1;
      return primary;
    },
  };
  const adapters = createRuntimeAdapters({}, () => settings, {
    audioOutput: macAudioOutput,
    recordingBusDeviceUid: OBS_RECORDING_DEVICE_UID,
  });
  const readiness = await adapters.output.probe();
  assert.equal(readiness.ready, false);
  assert.equal(readiness.code, "recording_bus_requires_physical_default");
  await assert.rejects(() => adapters.output.prepare(
    settings,
    { sampleRate: 22_050, channels: 1, sampleFormat: "f32le" },
    () => {},
  ), /default output is an aggregate device/);
  assert.equal(prepareCalls, 1);
});

test("recording bus blocks when aggregate membership cannot be fully attested", async () => {
  const settings = { sourceMode: "desktop-application", recordingBusEnabled: true };
  let probeCalls = 0;
  let closes = 0;
  const primary = {
    deviceUid: "unknown-aggregate",
    memberDeviceUids: [],
    memberDeviceUidsVerified: false,
    isAggregateDevice: false,
    write: async () => {},
    close: async () => { closes += 1; },
  };
  const macAudioOutput = {
    probe: async () => {
      probeCalls += 1;
      return {
        ready: true,
        code: "ready",
        detail: "Unverified aggregate",
        deviceUid: primary.deviceUid,
        memberDeviceUids: [],
        memberDeviceUidsVerified: false,
        isAggregateDevice: false,
      };
    },
    prepare: async () => primary,
  };
  const adapters = createRuntimeAdapters({}, () => settings, {
    audioOutput: macAudioOutput,
    recordingBusDeviceUid: OBS_RECORDING_DEVICE_UID,
  });
  const readiness = await adapters.output.probe();
  assert.equal(readiness.ready, false);
  assert.equal(readiness.code, "default_output_membership_unverified");
  assert.equal(probeCalls, 1);
  await assert.rejects(() => adapters.output.prepare(
    settings,
    { sampleRate: 22_050, channels: 1, sampleFormat: "f32le" },
    () => {},
  ), /could not verify every member/);
  assert.equal(closes, 1);
});
