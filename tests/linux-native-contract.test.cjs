"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const capture = fs.readFileSync(path.join(root, "native/linux/PipeWireCapture.cpp"), "utf8");
const output = fs.readFileSync(path.join(root, "native/linux/PipeWireOutput.cpp"), "utf8");
const build = fs.readFileSync(path.join(root, "scripts/linux-build-native.cjs"), "utf8");

test("Linux capture reads only a policy-owned ingress and never rewrites foreign links", () => {
  assert.match(capture, /chatgpt-persona-voice\.ingress\./);
  assert.match(capture, /PW_KEY_STREAM_CAPTURE_SINK/);
  assert.match(capture, /auditCaptureLinksLocked/);
  assert.match(capture, /wireplumber-prelink-policy/);
  assert.doesNotMatch(capture, /pw_core_create_object|"link-factory"|pw_registry_destroy|PW_KEY_OBJECT_LINGER/);
  assert.doesNotMatch(capture, /\bsystem\s*\(|popen\s*\(|pw-link|pw-cli/);
});

test("Linux capture is bounded, route-specific, and emits PCM only after mute proof", () => {
  assert.match(capture, /kCaptureQueueSlots = 64/);
  assert.match(capture, /--route/);
  assert.match(capture, /supportedRouteIds/);
  assert.match(capture, /grok-bot/);
  assert.match(capture, /waitForBypassMute\(true/);
  assert.match(capture, /suppressed_\.load/);
  assert.match(capture, /routeOwnershipVerified\\\":true/);
  assert.ok(capture.indexOf("waitForBypassMute(true") < capture.indexOf("captureEnabled_.store(true"));
});

test("Linux rollback and crash recovery retain explicit ownership proof", () => {
  const release = /bool release\([\s\S]+?return true;\n  }/.exec(capture)?.[0] ?? "";
  assert.match(release, /captureEnabled_\.store\(false/);
  assert.ok(release.indexOf("setAndProveBypassMute(false") < release.indexOf("suppressed_.store(false"));
  assert.ok(release.indexOf("suppressed_.store(false") < release.indexOf("destroyCaptureStreamLocked"));
  assert.match(capture, /PR_SET_PDEATHSIG/);
  assert.match(capture, /LOCK_EX \| LOCK_NB/);
  assert.match(capture, /supportsCrashRecovery\\\":true/);
});

test("Linux output is a native PipeWire stream with a bounded 500 ms jitter buffer", () => {
  assert.match(output, /pw_stream_new_simple\(/);
  assert.match(output, /PW_STREAM_FLAG_AUTOCONNECT/);
  assert.match(output, /kQueueCapacityFrames = 64/);
  assert.match(output, /kStartupPrebufferMs = 500/);
  assert.doesNotMatch(output, /\bsystem\s*\(|popen\s*\(|pw-play|pw-cat/);
});

test("Linux build emits the helper names expected by packaged and development runtimes", () => {
  assert.match(build, /native\/bin\/linux\/cpv-audio-capture/);
  assert.match(build, /native\/bin\/linux\/cpv-audio-output/);
  assert.match(build, /libpipewire-0\.3/);
  assert.match(build, /-Werror/);
});
