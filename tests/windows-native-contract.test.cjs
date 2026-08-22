"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const capture = read("native/windows/ProcessLoopbackCapture.cpp");
const output = read("native/windows/WasapiOutput.cpp");
const route = read("native/windows/AudioPolicyRoute.cpp");
const common = read("native/windows/WindowsAudioCommon.hpp");
const cmake = read("native/windows/CMakeLists.txt");
const nativeBuild = read("scripts/windows-build-native.cjs");
const packageJson = JSON.parse(read("package.json"));

test("Windows capture uses the documented endpoint-independent process-loopback API", () => {
  assert.match(capture, /ActivateAudioInterfaceAsync\(/);
  assert.match(capture, /VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK/);
  assert.match(capture, /PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE/);
  assert.match(capture, /kMinimumWindowsBuild = 20'348/);
  assert.match(capture, /Microsoft::WRL::FtmBase/);
  assert.match(capture, /supportsSuppression/);
  assert.match(capture, /owned-virtual-endpoint-required/);
});

test("Windows route verifies the official VB-CABLE endpoint and uses no private policy mutation", () => {
  assert.match(route, /RegisterSessionNotification\(/);
  assert.match(route, /RegisterAudioSessionNotification\(/);
  assert.match(route, /RegisterEndpointNotificationCallback\(/);
  assert.match(route, /supportsCurrentSessionMembershipProof/);
  assert.match(route, /notificationGuaranteesPreAudio/);
  assert.match(route, /restoreRequired.*true/);
  assert.match(route, /standbyPassthroughRequired.*true/);
  assert.match(route, /vb-audio-vb-cable-input-v1/);
  assert.match(route, /virtualCableInstalled/);
  assert.match(route, /virtualCableCount/);
  assert.match(route, /isVbCableInput/);
  assert.match(common, /PKEY_Device_DeviceDesc/);
  assert.match(common, /PKEY_Device_MatchingDeviceId/);
  assert.match(common, /kVbCableInputDeviceDescription\[\] = L"CABLE Input"/);
  assert.match(common, /kVbCableMatchingDeviceId\[\] = L"VBAudioVACWDM"/);
  assert.doesNotMatch(common, /PKEY_DeviceInterface_FriendlyName/);
  assert.doesNotMatch(route, /IAudioPolicyConfig|SetPersistedDefaultAudioEndpoint|RoGetActivationFactory/);
  assert.doesNotMatch(route, /ISimpleAudioVolume|SetMute\(/);
});

test("Windows output is bounded and rejects VB-CABLE as a physical destination", () => {
  assert.match(output, /kConvertedStartupPrebufferMs = 500/);
  assert.match(output, /kConvertedQueueCapacityMs = 1'500/);
  assert.match(output, /kPassthroughStartupPrebufferMs = 40/);
  assert.match(output, /kPassthroughQueueCapacityMs = 250/);
  assert.match(output, /mode == OutputMode::Passthrough/);
  assert.match(output, /AUDCLNT_BUFFERFLAGS_SILENT/);
  assert.match(output, /output_device_is_suppression_sink/);
  assert.match(output, /isVbCableInput/);
  assert.match(output, /suppressionSink/);
});

test("Windows build and installer require no bundled kernel driver or elevation", () => {
  for (const name of [
    "cpv-audio-capture.exe", "cpv-audio-output.exe", "cpv-audio-route.exe",
  ]) assert.match(nativeBuild, new RegExp(name.replaceAll(".", "\\.")));
  assert.doesNotMatch(nativeBuild, /cpv-driver-manager/);
  assert.doesNotMatch(cmake, /cpv-driver-manager|DriverManager/);
  assert.equal(packageJson.build.nsis.perMachine, false);
  assert.equal(packageJson.build.nsis.allowElevation, false);
  assert.equal(packageJson.build.nsis.include, undefined);
  assert.equal(packageJson.build.win.extraResources.length, 3);
});

test("Windows user-mode native helpers compile with MSVC", {
  skip: process.platform !== "win32",
  timeout: 180_000,
}, () => {
  execFileSync(process.execPath, [path.join(root, "scripts/windows-build-native.cjs")], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
});
