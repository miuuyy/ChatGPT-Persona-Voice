"use strict";

const { WindowsAudioOutput } = require("./windows-audio-output.cjs");
const { WindowsProcessRoute } = require("./windows-process-route.cjs");
const { WindowsRouteLifecycle } = require("./windows-route-lifecycle.cjs");

const WINDOWS_PACKAGED_NATIVE_FILES = Object.freeze([
  "native/win32/cpv-audio-capture.exe",
  "native/win32/cpv-audio-output.exe",
  "native/win32/cpv-audio-route.exe",
]);

function createWindowsIntegration({
  captureHelperPath,
  outputHelperPath,
  routeHelperPath,
  logger = null,
  processRouteOptions = {},
  outputOptions = {},
  lifecycleOptions = {},
} = {}) {
  const rawProcessRoute = new WindowsProcessRoute({
    captureHelperPath,
    routeHelperPath,
    logger,
    ...processRouteOptions,
  });
  const audioOutput = new WindowsAudioOutput({
    helperPath: outputHelperPath,
    logger,
    ...outputOptions,
  });
  const routeLifecycle = new WindowsRouteLifecycle({
    ...lifecycleOptions,
    processRoute: rawProcessRoute,
    audioOutput,
    logger,
  });
  return {
    processRoute: routeLifecycle,
    audioOutput,
    routeLifecycle,
    rawProcessRoute,
  };
}

module.exports = { WINDOWS_PACKAGED_NATIVE_FILES, createWindowsIntegration };
