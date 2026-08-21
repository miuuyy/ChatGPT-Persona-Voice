"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  WINDOWS_PACKAGED_NATIVE_FILES,
  createWindowsIntegration,
} = require("../electron/windows-integration.cjs");
const { WindowsAudioOutput } = require("../electron/windows-audio-output.cjs");
const { WindowsRouteLifecycle } = require("../electron/windows-route-lifecycle.cjs");

test("Windows main-process factory installs the lifecycle wrapper as the runtime process route", () => {
  const integration = createWindowsIntegration({
    captureHelperPath: "C:\\resources\\native\\win32\\cpv-audio-capture.exe",
    outputHelperPath: "C:\\resources\\native\\win32\\cpv-audio-output.exe",
    routeHelperPath: "C:\\resources\\native\\win32\\cpv-audio-route.exe",
    processRouteOptions: { platform: "win32" },
    outputOptions: { platform: "win32" },
  });
  assert.ok(integration.processRoute instanceof WindowsRouteLifecycle);
  assert.equal(integration.processRoute, integration.routeLifecycle);
  assert.ok(integration.audioOutput instanceof WindowsAudioOutput);
  assert.equal(integration.driverManager, undefined);
});

test("Windows packaging contract includes only the three user-mode audio helpers", () => {
  assert.deepEqual(WINDOWS_PACKAGED_NATIVE_FILES, [
    "native/win32/cpv-audio-capture.exe",
    "native/win32/cpv-audio-output.exe",
    "native/win32/cpv-audio-route.exe",
  ]);
  assert.equal(WINDOWS_PACKAGED_NATIVE_FILES.some((file) => file.includes("/build/")), false);
});
