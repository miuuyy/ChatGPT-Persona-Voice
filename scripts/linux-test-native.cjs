"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { NativeFrameParser } = require("../electron/native-protocol.cjs");

const PROJECT_ROOT = path.join(__dirname, "..");

function selfTest(executable, helper) {
  const result = spawnSync(executable, ["--self-test"], {
    cwd: PROJECT_ROOT,
    encoding: null,
    timeout: 5_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString("utf8").trim() || `${helper} PipeWire self-test exited with ${result.status}`);
  }
  const messages = [];
  const parser = new NativeFrameParser((message) => messages.push(message));
  parser.push(result.stdout);
  parser.finish();
  if (messages.length !== 1 || messages[0].type !== "ready" || messages[0].helper !== helper ||
      messages[0].protocolVersion !== 1) {
    throw new Error(`${helper} returned an invalid CPV1 PipeWire readiness frame`);
  }
  return messages[0];
}

function testLinuxNative(platform = process.platform) {
  if (platform !== "linux") throw new Error("Linux PipeWire helpers must be tested inside a Linux desktop session");
  const capture = selfTest(path.join(PROJECT_ROOT, "native/bin/linux/cpv-audio-capture"), "capture");
  const output = selfTest(path.join(PROJECT_ROOT, "native/bin/linux/cpv-audio-output"), "output");
  if (capture.supportsProcessScopedRouting !== true || capture.supportsRollbackProof !== true ||
      capture.supportsPrelinkedIngress !== true || capture.supportsDynamicProcessStreams !== true ||
      capture.supportsCrashRecovery !== true || capture.policyProbeVerified !== true ||
      capture.policyVersion !== 3 || capture.routeOwner !== "wireplumber-prelink-policy" ||
      !Array.isArray(capture.supportedRouteIds) ||
      !capture.supportedRouteIds.includes("chatgpt") || !capture.supportedRouteIds.includes("codex") ||
      !capture.supportedRouteIds.includes("grok-bot")) {
    throw new Error("Capture helper did not prove the WirePlumber pre-link and crash-recovery contract");
  }
  if (output.supportsNativePipeWire !== true || output.supportsJitterBuffer !== true ||
      output.queueCapacityFrames !== 64 || output.startupPrebufferMs !== 500) {
    throw new Error("Output helper did not prove the bounded native PipeWire output contract");
  }
  console.log("Linux PipeWire capture and output native self-tests passed.");
}

if (require.main === module) {
  try { testLinuxNative(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { selfTest, testLinuxNative };
