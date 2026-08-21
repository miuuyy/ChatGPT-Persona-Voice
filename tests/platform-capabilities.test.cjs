"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { findExecutable, probePlatformCapabilities, versionAtLeast } = require("../electron/platform-capabilities.cjs");
const { PlatformAudioSetupController } = require("../electron/platform-audio-setup.cjs");

test("platform utility validation handles numeric versions and explicit executable paths", () => {
  assert.equal(versionAtLeast("14.2", "14.2"), true);
  assert.equal(versionAtLeast("14.10.1", "14.2"), true);
  assert.equal(versionAtLeast("14.1.9", "14.2"), false);
  assert.equal(versionAtLeast("unknown", "14.2"), false);
  const exists = (candidate) => candidate === "/opt/codex/bin/codex";
  assert.equal(findExecutable("codex", {
    platform: "darwin",
    environment: { CODEX_PERSONA_VOICE_CODEX_BIN: "/opt/codex/bin/codex", PATH: "" },
    exists,
  }), "/opt/codex/bin/codex");
  assert.throws(() => findExecutable("codex", {
    platform: "darwin",
    environment: { CODEX_PERSONA_VOICE_CODEX_BIN: "relative/codex", PATH: "" },
    exists,
  }), /must be absolute/);
});

test("platform capabilities require native helpers plus live Linux policy or Windows sink proof", async () => {
  const missingHelpers = probePlatformCapabilities({
    platform: "darwin",
    macVersion: "14.2",
    release: "23.2.0",
    environment: { PATH: "" },
    exists: () => false,
  });
  assert.equal(missingHelpers.desktopCapture.possible, true);
  assert.equal(missingHelpers.desktopCapture.ready, false);
  assert.equal(missingHelpers.suppression.possible, true);
  assert.equal(missingHelpers.suppression.ready, false);
  assert.equal(missingHelpers.engine.ready, false);

  const installedHelpers = probePlatformCapabilities({
    platform: "darwin",
    macVersion: "15.0",
    release: "24.0.0",
    environment: { PATH: "" },
    helperPaths: { capture: "/app/capture", output: "/app/output" },
    exists: (candidate) => candidate === "/app/capture" || candidate === "/app/output",
  });
  assert.equal(installedHelpers.desktopCapture.ready, true);
  assert.equal(installedHelpers.suppression.ready, true);
  assert.equal(installedHelpers.output.ready, true);
  assert.equal(installedHelpers.engine.ready, false);

  const linuxPaths = new Set([
    "/tools/pw-dump",
    "/tools/wireplumber",
    "/app/cpv-audio-capture",
    "/app/cpv-audio-output",
  ]);
  const linux = probePlatformCapabilities({
    platform: "linux",
    release: "6.8.0",
    environment: { PATH: "/tools" },
    helperPaths: {
      capture: "/app/cpv-audio-capture",
      output: "/app/cpv-audio-output",
    },
    exists: (candidate) => linuxPaths.has(candidate),
  });
  assert.equal(linux.desktopCapture.possible, true);
  assert.equal(linux.desktopCapture.ready, true);
  assert.equal(linux.suppression.possible, true);
  assert.equal(linux.suppression.ready, false);
  assert.equal(linux.suppression.code, "linux_policy_probe_required");
  assert.equal(linux.output.ready, true);

  const linuxWithoutHelpers = probePlatformCapabilities({
    platform: "linux",
    release: "6.8.0",
    environment: { PATH: "/tools" },
    exists: (candidate) => ["/tools/pw-dump", "/tools/wireplumber"].includes(candidate),
  });
  assert.equal(linuxWithoutHelpers.desktopCapture.ready, false);
  assert.equal(linuxWithoutHelpers.desktopCapture.code, "linux_capture_helper_missing");
  assert.equal(linuxWithoutHelpers.suppression.code, "linux_capture_helper_missing");
  assert.equal(linuxWithoutHelpers.output.code, "linux_output_helper_missing");

  const windowsPaths = new Set(["capture.exe", "route.exe", "output.exe"]);
  const windows = probePlatformCapabilities({
    platform: "win32",
    release: "10.0.26100",
    environment: { PATH: "", PATHEXT: ".EXE" },
    helperPaths: {
      capture: "capture.exe",
      route: "route.exe",
      output: "output.exe",
    },
    exists: (candidate) => windowsPaths.has(candidate),
  });
  assert.equal(windows.desktopCapture.possible, true);
  assert.equal(windows.desktopCapture.ready, true);
  assert.equal(windows.suppression.possible, true);
  assert.equal(windows.suppression.ready, false);
  assert.equal(windows.suppression.code, "windows_sink_probe_required");
  assert.equal(windows.output.ready, true);

  const windowsWithoutHelpers = probePlatformCapabilities({
    platform: "win32",
    release: "10.0.26100",
    environment: { PATH: "", PATHEXT: ".EXE" },
    exists: () => false,
  });
  assert.equal(windowsWithoutHelpers.desktopCapture.possible, true);
  assert.equal(windowsWithoutHelpers.desktopCapture.ready, false);
  assert.equal(windowsWithoutHelpers.desktopCapture.code, "windows_capture_helper_missing");
  assert.equal(windowsWithoutHelpers.suppression.possible, true);
  assert.equal(windowsWithoutHelpers.suppression.ready, false);
  assert.equal(windowsWithoutHelpers.suppression.code, "windows_route_helper_missing");
  assert.equal(windowsWithoutHelpers.output.code, "windows_output_helper_missing");

  let linuxInstalled = false;
  const linuxSetup = new PlatformAudioSetupController({
    platform: "linux",
    linuxPolicy: {
      inspectPolicy: () => ({
        installed: linuxInstalled,
        conflict: false,
        reloadRequired: !linuxInstalled,
      }),
    },
    linuxProcessRoute: {
      helperReadiness: async () => ({ ready: true, code: "ready", detail: "live" }),
    },
    runLinuxAction: async (action) => {
      assert.equal(action, "install");
      linuxInstalled = true;
    },
  });
  assert.equal((await linuxSetup.inspect({})).status, "action-required");
  assert.deepEqual(await linuxSetup.install({}), {
    status: "ready",
    code: "ready",
    detail: "The owned PipeWire and WirePlumber route passed its live isolation probe",
    canInstall: false,
    canActivate: false,
    requiresRouteAssignment: false,
    canRemove: true,
  });

  let standbyActive = false;
  const windowsIntegration = {
    rawProcessRoute: {
      helperReadiness: async () => ({ ready: true, code: "ready", detail: "native" }),
    },
    routeLifecycle: {
      snapshot: () => ({ standbyActive }),
      startStandby: async () => { standbyActive = true; },
    },
  };
  const windowsSetup = new PlatformAudioSetupController({
    platform: "win32",
    windowsIntegration,
  });
  const required = await windowsSetup.inspect({ sourceMode: "desktop-application" });
  assert.equal(required.code, "windows_route_assignment_required");
  assert.equal(required.canActivate, true);
  assert.equal((await windowsSetup.activate({}, {})).status, "ready");

  const missingCable = new PlatformAudioSetupController({
    platform: "win32",
    windowsIntegration: {
      rawProcessRoute: {
        helperReadiness: async () => ({
          ready: false,
          code: "windows_vb_cable_required",
          detail: "missing",
        }),
      },
      routeLifecycle: { snapshot: () => ({ standbyActive: false }) },
    },
  });
  assert.deepEqual(await missingCable.inspect({}), {
    status: "action-required",
    code: "windows_vb_cable_required",
    detail: "Install VB-CABLE from the official VB-Audio site, restart Windows, then check again",
    canInstall: false,
    canActivate: false,
    requiresRouteAssignment: false,
    canRemove: false,
  });
});
