"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { NativeFrameParser } = require("../electron/native-protocol.cjs");

const PROJECT_ROOT = path.join(__dirname, "..");

function selfTest(name, expectedHelper) {
  const executable = path.join(PROJECT_ROOT, "native", "bin", "win32", name);
  const result = spawnSync(executable, ["--self-test"], {
    cwd: PROJECT_ROOT,
    encoding: null,
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString("utf8").trim() ||
      `${name} self-test exited with ${String(result.status)}`);
  }
  const messages = [];
  const parser = new NativeFrameParser((message) => messages.push(message));
  parser.push(result.stdout);
  parser.finish();
  if (messages.length !== 1 || messages[0].type !== "ready" ||
      messages[0].helper !== expectedHelper || messages[0].protocolVersion !== 1) {
    throw new Error(`${name} returned an invalid CPV1 readiness frame`);
  }
  return messages[0];
}

function testWindowsNative({ platform = process.platform, requireAudioDevice = false } = {}) {
  if (platform !== "win32") throw new Error("Windows native helpers must be tested on Windows");
  const capture = selfTest("cpv-audio-capture.exe", "capture");
  if (capture.backend !== "wasapi-process-loopback" ||
      capture.minimumWindowsBuild !== 20_348 ||
      capture.supportsSuppression !== false) {
    throw new Error("Capture helper did not prove the Windows process-loopback boundary");
  }
  const route = selfTest("cpv-audio-route.exe", "route");
  if (route.backend !== "windows-virtual-endpoint-verifier" ||
      route.routeMutation !== false || route.notificationGuaranteesPreAudio !== false ||
      route.supportsEventDrivenMonitoring !== true || route.restoreRequired !== true ||
      route.restoreMechanism !== "manual-volume-mixer" ||
      route.standbyPassthroughRequired !== true) {
    throw new Error("Route helper did not prove its Windows session-monitor boundary");
  }
  if (requireAudioDevice) {
    const output = selfTest("cpv-audio-output.exe", "output");
    if (output.backend !== "wasapi-shared-render" || output.suppressionSink !== false ||
        output.queueCapacityMs !== 1_500 || output.startupPrebufferMs !== 500) {
      throw new Error("Output helper did not prove its bounded physical-device contract");
    }
  }
  return { capture, route };
}

if (require.main === module) {
  try {
    const requireAudioDevice = process.argv.includes("--require-audio-device");
    testWindowsNative({ requireAudioDevice });
    console.log("Windows process-loopback and route native self-tests passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { selfTest, testWindowsNative };
