"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MAX_CONVERSION_HANDOFF_QUEUED_MS,
  MAX_PASSTHROUGH_QUEUED_MS,
  WindowsRouteLifecycle,
} = require("../electron/windows-route-lifecycle.cjs");

const format = Object.freeze({ sampleRate: 48_000, channels: 2, sampleFormat: "f32le" });
const settings = Object.freeze({
  sourceMode: "desktop-application",
  targetApp: "chatgpt",
  sourceId: "chatgpt.exe:10",
  sourceName: "ChatGPT",
});
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function frame(sequence, samplesPerChannel = 480) {
  return {
    sequence,
    sampleRate: format.sampleRate,
    channels: format.channels,
    sampleFormat: format.sampleFormat,
    samplesPerChannel,
    pcm: Buffer.alloc(samplesPerChannel * format.channels * 4),
  };
}

function fixture({ onManualRouteConfigured = null } = {}) {
  let routeError = null;
  let routeStatus = null;
  let openStream = null;
  let baseCloseCount = 0;
  const opens = [];
  const outputs = [];
  const processRoute = {
    probe: async () => ({ ready: true, code: "ready", detail: "ready" }),
    describe: async () => ({ ...format }),
    acquire: async (_settings, onError, onStatus) => {
      routeError = onError;
      routeStatus = onStatus;
      onStatus({
        type: "status",
        state: "engaged",
        originalSuppressed: true,
        routeVerified: true,
      });
      return {
        armed: true,
        originalSuppressed: true,
        restorationUnproven: false,
        format: { ...format },
        close: async () => { baseCloseCount += 1; },
      };
    },
    open: (_settings, onFrame, onError) => {
      const token = { onFrame, onError, closed: false };
      openStream = token;
      opens.push(token);
      return {
        format: { ...format },
        close: async () => {
          token.closed = true;
          if (openStream === token) openStream = null;
        },
      };
    },
  };
  const audioOutput = {
    prepare: async (config, preparedFormat, onError) => {
      assert.deepEqual(preparedFormat, format);
      const output = {
        config,
        writes: [],
        closed: false,
        onError,
        write: async (value) => { output.writes.push(value); },
        close: async () => { output.closed = true; },
      };
      outputs.push(output);
      return output;
    },
  };
  const lifecycle = new WindowsRouteLifecycle({
    processRoute,
    audioOutput,
    onManualRouteConfigured,
  });
  return {
    lifecycle,
    audioOutput,
    opens,
    outputs,
    emitFrame: (value) => openStream?.onFrame(value),
    emitRouteError: (error) => routeError?.(error),
    emitRouteStatus: (status) => routeStatus?.(status),
    baseCloseCount: () => baseCloseCount,
  };
}

test("Windows lifecycle keeps an owned low-latency passthrough while conversion is stopped", async () => {
  let configured = 0;
  const value = fixture({ onManualRouteConfigured: () => { configured += 1; } });
  await value.lifecycle.startStandby(settings);
  assert.equal(value.lifecycle.snapshot().state, "standby");
  assert.equal(value.outputs.length, 1);
  assert.equal(value.outputs[0].config.outputMode, "passthrough");

  value.emitFrame(frame(0));
  await nextTurn();
  assert.equal(value.outputs[0].writes.length, 1);
  assert.equal(value.baseCloseCount(), 0);
  assert.equal(configured, 1);
  value.lifecycle.markManualRouteConfigured();
  assert.equal(configured, 1);
});

test("Windows Start hands the retained stream to conversion and Stop returns to passthrough", async () => {
  const value = fixture();
  await value.lifecycle.startStandby(settings);
  const conversionFrames = [];
  const statuses = [];
  const guard = await value.lifecycle.acquire(
    settings,
    () => {},
    (status) => statuses.push(status),
  );
  assert.equal(value.outputs[0].closed, true);
  assert.equal(value.opens[0].closed, false);
  assert.equal(value.baseCloseCount(), 0);
  assert.equal(guard.armed, true);

  const stream = value.lifecycle.open(settings, (audio) => conversionFrames.push(audio), () => {});
  value.emitFrame(frame(7));
  assert.equal(conversionFrames.length, 0);
  await stream.activate();
  assert.equal(conversionFrames.length, 1);
  assert.equal(statuses.at(-1).state, "engaged");
  await stream.close();
  await guard.close();

  assert.equal(value.lifecycle.snapshot().state, "standby");
  assert.equal(value.outputs.length, 2);
  assert.equal(value.outputs[1].config.outputMode, "passthrough");
  assert.equal(value.baseCloseCount(), 0);
  assert.equal(value.opens.length, 1);
  assert.equal(value.opens[0].closed, false);
  value.emitFrame(frame(8));
  await nextTurn();
  assert.equal(value.outputs[1].writes.length, 1);
});

test("Windows conversion handoff retains every capture frame while standby output drains", async () => {
  const value = fixture();
  await value.lifecycle.startStandby(settings);
  let finishStandbyClose;
  value.outputs[0].close = () => new Promise((resolve) => {
    finishStandbyClose = () => {
      value.outputs[0].closed = true;
      resolve();
    };
  });

  const acquiring = value.lifecycle.acquire(settings, () => {}, () => {});
  await nextTurn();
  value.emitFrame(frame(20));
  value.emitFrame(frame(21));
  finishStandbyClose();
  const guard = await acquiring;
  const converted = [];
  const stream = value.lifecycle.open(settings, (audio) => converted.push(audio.sequence), () => {});
  value.emitFrame(frame(22));
  assert.deepEqual(converted, []);

  await stream.activate();
  assert.deepEqual(converted, [20, 21, 22]);
  assert.equal(value.opens.length, 1);
  assert.equal(value.opens[0].closed, false);

  await stream.pause();
  value.emitFrame(frame(23));
  assert.deepEqual(converted, [20, 21, 22]);
  await stream.activate();
  assert.deepEqual(converted, [20, 21, 22, 23]);
  await stream.close();

  const prepareStandby = value.audioOutput.prepare;
  let resumeStandbyPrepare;
  value.audioOutput.prepare = async (...args) => {
    await new Promise((resolve) => { resumeStandbyPrepare = resolve; });
    return prepareStandby(...args);
  };
  const returningToStandby = guard.close();
  await nextTurn();
  value.emitFrame(frame(24));
  resumeStandbyPrepare();
  await returningToStandby;
  await nextTurn();
  assert.deepEqual(value.outputs[1].writes.map((audio) => audio.sequence), [24]);
});

test("Windows standby fails closed when its JS queue exceeds the native passthrough bound", async () => {
  const value = fixture();
  const failures = [];
  await value.lifecycle.startStandby(settings, { onError: (error) => failures.push(error) });
  let releaseWrite;
  value.outputs[0].write = () => new Promise((resolve) => { releaseWrite = resolve; });
  const tenMsSamples = format.sampleRate / 100;
  for (let index = 0; index <= MAX_PASSTHROUGH_QUEUED_MS / 10; ++index) {
    value.emitFrame(frame(index, tenMsSamples));
  }
  assert.equal(value.lifecycle.snapshot().state, "faulted");
  assert.equal(failures[0].code, "windows_standby_queue_exceeded");
  assert.equal(failures[0].suppressionHeld, true);
  releaseWrite?.();
  await nextTurn();
});

test("Windows conversion handoff fails closed instead of dropping an unbounded transition", async () => {
  const value = fixture();
  const failures = [];
  await value.lifecycle.startStandby(settings);
  let finishStandbyClose;
  value.outputs[0].close = () => new Promise((resolve) => { finishStandbyClose = resolve; });
  const acquiring = value.lifecycle.acquire(settings, (error) => failures.push(error), () => {});
  await nextTurn();

  const tenMsSamples = format.sampleRate / 100;
  for (let index = 0; index <= MAX_CONVERSION_HANDOFF_QUEUED_MS / 10; ++index) {
    value.emitFrame(frame(index, tenMsSamples));
  }
  finishStandbyClose();

  let failure;
  try { await acquiring; }
  catch (error) { failure = error; }
  assert.equal(failure?.code, "windows_conversion_handoff_queue_exceeded");
  assert.equal(failure?.suppressionHeld, true);
  assert.equal(typeof failure?.suppressionSession?.close, "function");
  assert.equal(failures[0], failure);
  assert.equal(value.lifecycle.snapshot().state, "faulted");
  await failure.suppressionSession.close();
  assert.equal(value.lifecycle.snapshot().state, "standby");
});

test("Windows Quit is blocked until the user explicitly restores the persistent Volume Mixer route", async () => {
  const value = fixture();
  await value.lifecycle.startStandby(settings);
  await assert.rejects(
    value.lifecycle.shutdown(),
    (error) => error.code === "windows_manual_route_restore_required" && error.requiresUserAction === true,
  );
  const requirement = await value.lifecycle.beginManualRestore();
  assert.equal(requirement.required, true);
  assert.equal(requirement.persistentRoutingResetProven, false);
  await assert.rejects(
    value.lifecycle.completeManualRestore(),
    (error) => error.code === "windows_manual_route_restore_required",
  );

  const result = await value.lifecycle.completeManualRestore({ userConfirmed: true });
  assert.equal(result.released, true);
  assert.equal(result.routingResetProven, false);
  assert.equal(result.persistentRoutingResetProven, false);
  assert.equal(value.baseCloseCount(), 1);
  assert.equal(value.lifecycle.snapshot().state, "shutdown");
});

test("Windows lifecycle distinguishes a current off-sink session observation from persistent-policy proof", async () => {
  const value = fixture();
  await value.lifecycle.startStandby(settings);
  await value.lifecycle.beginManualRestore();
  const routeLoss = new Error("target session moved to Speakers");
  routeLoss.code = "windows_target_route_lost";
  routeLoss.suppressionHeld = false;
  value.emitRouteError(routeLoss);
  await nextTurn();

  const result = await value.lifecycle.completeManualRestore();
  assert.equal(result.routingResetProven, true);
  assert.equal(result.persistentRoutingResetProven, false);
  assert.equal(result.userConfirmed, false);
  assert.equal(value.baseCloseCount(), 1);
});

test("Cancelling the Windows quit prompt leaves standby passthrough live", async () => {
  const value = fixture();
  await value.lifecycle.startStandby(settings);
  await value.lifecycle.beginManualRestore();
  value.emitFrame(frame(1));
  await nextTurn();
  assert.equal(value.outputs[0].writes.length, 1);

  const cancelled = await value.lifecycle.cancelManualRestore();
  assert.equal(cancelled.state, "standby");
  assert.equal(cancelled.standbyActive, true);
  assert.equal(value.baseCloseCount(), 0);
  value.emitFrame(frame(2));
  await nextTurn();
  assert.equal(value.outputs[0].writes.length, 2);
});

test("Windows lifecycle refuses to switch target ownership before manual route restoration", async () => {
  const value = fixture();
  await value.lifecycle.startStandby(settings);
  await assert.rejects(
    value.lifecycle.acquire(
      { ...settings, sourceId: "codex.exe:20", sourceName: "Codex" },
      () => {},
      () => {},
    ),
    (error) => error.code === "windows_source_change_requires_route_restore",
  );
  assert.equal(value.baseCloseCount(), 0);
  assert.equal(value.lifecycle.snapshot().state, "standby");
});

test("Windows lifecycle treats a ChatGPT to Grok Bot switch as new route ownership", async () => {
  const value = fixture();
  await value.lifecycle.startStandby(settings);
  await assert.rejects(
    value.lifecycle.acquire(
      {
        ...settings,
        targetApp: "grok-bot",
        sourceId: null,
        sourceName: null,
      },
      () => {},
      () => {},
    ),
    (error) => error.code === "windows_source_change_requires_route_restore",
  );
  assert.equal(value.baseCloseCount(), 0);
  assert.equal(value.lifecycle.snapshot().manualRestoreRequired, true);
});

test("Windows Stop retains the native guard when standby output cannot be restored", async () => {
  const value = fixture();
  await value.lifecycle.startStandby(settings);
  const guard = await value.lifecycle.acquire(settings, () => {}, () => {});
  const stream = value.lifecycle.open(settings, () => {}, () => {});
  await stream.close();
  value.audioOutput.prepare = async () => {
    const error = new Error("physical output unavailable");
    error.code = "windows_output_unavailable";
    throw error;
  };

  await assert.rejects(guard.close(), /physical output unavailable/);
  assert.equal(value.lifecycle.snapshot().state, "faulted");
  assert.equal(value.lifecycle.snapshot().routeHeld, true);
  assert.equal(value.baseCloseCount(), 0);

  const restore = await value.lifecycle.beginManualRestore();
  assert.equal(restore.required, true);
  await value.lifecycle.completeManualRestore({ userConfirmed: true });
  assert.equal(value.baseCloseCount(), 1);
});

test("Windows lifecycle can re-own the same persistent route after ChatGPT restarts", async () => {
  const value = fixture();
  await value.lifecycle.startStandby(settings);
  const exited = new Error("ChatGPT exited");
  exited.code = "source_process_exited";
  exited.suppressionHeld = false;
  value.emitRouteError(exited);
  await nextTurn();

  const recovered = await value.lifecycle.recoverStandbyAfterSourceRestart(settings);
  assert.equal(recovered.state, "standby");
  assert.equal(recovered.error, null);
  assert.equal(value.baseCloseCount(), 1);
  assert.equal(value.outputs.length, 2);
  assert.equal(value.outputs[1].config.outputMode, "passthrough");

  const active = fixture();
  await active.lifecycle.startStandby(settings);
  const guard = await active.lifecycle.acquire(settings, () => {}, () => {});
  active.lifecycle.open(settings, () => {}, () => {});
  const activeExit = new Error("ChatGPT exited during conversion");
  activeExit.code = "source_process_exited";
  activeExit.suppressionHeld = false;
  active.emitRouteError(activeExit);
  await nextTurn();
  await guard.close();
  assert.equal(active.lifecycle.snapshot().state, "faulted");
  assert.equal(active.lifecycle.snapshot().routeHeld, true);
  const activeRecovered = await active.lifecycle.recoverStandbyAfterSourceRestart(settings);
  assert.equal(activeRecovered.state, "standby");
  assert.equal(activeRecovered.error, null);
});

test("A persisted setup flag blocks quit even when no current helper could be acquired", async () => {
  const value = fixture();
  value.lifecycle.markManualRouteConfigured();
  await assert.rejects(
    value.lifecycle.shutdown(),
    (error) => error.code === "windows_manual_route_restore_required",
  );
  const requirement = await value.lifecycle.beginManualRestore();
  assert.equal(requirement.required, true);
  const cancelled = await value.lifecycle.cancelManualRestore();
  assert.equal(cancelled.state, "cold");
  await value.lifecycle.beginManualRestore();
  const result = await value.lifecycle.completeManualRestore({ userConfirmed: true });
  assert.equal(result.persistentRoutingResetProven, false);
  assert.equal(value.lifecycle.snapshot().manualRestoreRequired, false);
});
