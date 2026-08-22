"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.join(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("macOS package declares permissions and both native data-plane helpers", () => {
  assert.equal(packageJson.build.mac.minimumSystemVersion, "14.2");
  assert.match(packageJson.build.mac.extendInfo.NSAudioCaptureUsageDescription, /captures output/i);
  assert.equal(packageJson.build.mac.extendInfo.NSMicrophoneUsageDescription, undefined);
  assert.deepEqual(
    packageJson.build.mac.extraResources.map((entry) => entry.to).sort(),
    [
      "LICENSE.electron.txt",
      "LICENSES.chromium.html",
      "native/darwin/cpv-atomic-swap",
      "native/darwin/cpv-audio-capture",
      "native/darwin/cpv-audio-output",
    ],
  );
  assert.equal(packageJson.build.files.includes("LICENSE"), true);
  assert.equal(packageJson.build.files.includes("THIRD_PARTY_NOTICES.md"), true);
  assert.equal(packageJson.build.files.includes("third_party_licenses/**"), true);
  assert.equal(packageJson.build.mac.extraResources.some((entry) =>
    entry.from === "node_modules/electron/dist/LICENSE" && entry.to === "LICENSE.electron.txt"), true);
  assert.equal(packageJson.build.mac.extraResources.some((entry) =>
    entry.from === "node_modules/electron/dist/LICENSES.chromium.html" &&
      entry.to === "LICENSES.chromium.html"), true);
  assert.equal(packageJson.build.extraResources.some((entry) => entry.to === "voices"), true);
  assert.equal(packageJson.build.extraResources.some((entry) =>
    entry.from === "build/updater-runtime" && entry.to === "updater-runtime"), true);
  for (const destination of ["engine-installer", "engine/seed-vc", "engine/vendor/seed-vc"]) {
    assert.equal(packageJson.build.extraResources.some((entry) => entry.to === destination), true);
  }
  assert.equal(packageJson.build.mac.binaries.includes("Contents/Resources/updater-runtime/bun"), true);
  assert.equal(packageJson.build.mac.binaries.includes("Contents/Resources/native/darwin/cpv-atomic-swap"), true);
  assert.equal(packageJson.build.mac.binaries.includes("Contents/Resources/engine-installer/uv"), true);
});

test("one notice inventory covers every bundled voice and packaged bootstrap", () => {
  const notice = fs.readFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
  const voiceManifest = JSON.parse(
    fs.readFileSync(path.join(root, "voices", "manifest.json"), "utf8"),
  );
  const modelLock = JSON.parse(
    fs.readFileSync(path.join(root, "engine", "seed-vc", "model-lock.json"), "utf8"),
  );

  for (const voice of voiceManifest.voices) {
    assert.equal(notice.includes(voice.requiredCredit), true, `${voice.id} credit is missing`);
    assert.equal(notice.includes(voice.termsUrl), true, `${voice.id} terms URL is missing`);
  }
  assert.equal(notice.includes(modelLock.seedVcCommit), true);
  const gitlink = spawnSync(
    "git",
    ["ls-files", "-s", "engine/vendor/seed-vc"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(gitlink.status, 0, gitlink.stderr);
  assert.equal(gitlink.stdout.trim().split(/\s+/)[1], modelLock.seedVcCommit);
  assert.match(notice, new RegExp(`Bun ${packageJson.packageManager.split("@")[1]}`));
  assert.match(notice, new RegExp(`uv ${packageJson.engineInstaller.uvVersion}`));
  const bunLicense = fs.readFileSync(
    path.join(root, "third_party_licenses", "BUN-1.3.14-LICENSE.md"),
    "utf8",
  );
  assert.equal(packageJson.packageManager, "bun@1.3.14");
  assert.equal(
    createHash("sha256").update(bunLicense).digest("hex"),
    "2c6160ec8fb853f7e8f97d9b249e756c9b0ac44860a68b6bf4f1b0bcbc5c3741",
  );
  const uvLicense = fs.readFileSync(
    path.join(root, "third_party_licenses", "UV-0.11.14-LICENSE-MIT"),
    "utf8",
  );
  assert.match(bunLicense, /git submodule update --init --recursive/);
  assert.match(bunLicense, /make jsc/);
  assert.match(bunLicense, /zig build/);
  assert.match(uvLicense, /Copyright \(c\) 2025 Astral Software Inc\./);
  const reactLicense = fs.readFileSync(
    path.join(root, "third_party_licenses", "REACT-19-LICENSE"),
    "utf8",
  );
  assert.equal(reactLicense, fs.readFileSync(path.join(root, "node_modules", "react", "LICENSE"), "utf8"));
  assert.equal(reactLicense, fs.readFileSync(path.join(root, "node_modules", "react-dom", "LICENSE"), "utf8"));
  assert.equal(reactLicense, fs.readFileSync(path.join(root, "node_modules", "scheduler", "LICENSE"), "utf8"));
  for (const retiredNotice of [
    "voices/licenses/VOICEVOX.md",
    "voices/licenses/JARVIS.md",
    "voices/licenses/DONALD_TRUMP.md",
  ]) {
    assert.equal(fs.existsSync(path.join(root, retiredNotice)), false, retiredNotice);
  }
});

test("development and native packaging rebuild helpers instead of relying on stale binaries", () => {
  assert.match(packageJson.scripts.dev, /build:native/);
  assert.match(packageJson.scripts.dev, /test:native/);
  assert.match(packageJson.scripts["package:mac"], /build:native/);
  assert.match(packageJson.scripts["package:mac"], /test:native/);
  assert.match(packageJson.scripts["package:win"], /build:native/);
  assert.match(packageJson.scripts["package:win"], /test:native/);
  assert.match(packageJson.scripts["package:linux"], /build:native/);
  assert.match(packageJson.scripts["package:linux"], /test:native/);
  assert.deepEqual(packageJson.build.win.extraResources.map((entry) => entry.to).sort(), [
    "native/win32/cpv-audio-capture.exe",
    "native/win32/cpv-audio-output.exe",
    "native/win32/cpv-audio-route.exe",
  ]);
  assert.deepEqual(packageJson.build.linux.extraResources.map((entry) => entry.to).sort(), [
    "native/linux/THIRD_PARTY_NOTICES.md",
    "native/linux/cpv-audio-capture",
    "native/linux/cpv-audio-output",
    "native/linux/wireplumber",
  ]);
  const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  assert.match(gitignore, /^native\/bin\/$/m);
  assert.match(gitignore, /^models\/$/m);
});

test("experimental packages are local-only and receive a SHA-256 manifest", () => {
  const packaging = fs.readFileSync(path.join(root, "scripts", "package.cjs"), "utf8");
  assert.match(packaging, /"--publish",\s*"never"/);
  assert.match(packaging, /SHA256SUMS/);
  assert.match(packaging, /createHash\("sha256"\)/);
  assert.match(packaging, /entry\.name\.startsWith\(artifactPrefix\)/);
  assert.match(packaging, /process\.versions\.bun/);
  assert.match(packaging, /updater-runtime/);
  assert.match(packaging, /engine-installer/);
  assert.doesNotMatch(packaging, /CODEX_PERSONA_VOICE_SIGNED_DRIVER_DIR/);
  assert.doesNotMatch(packaging, /verifyMicrosoftSignedPackage|assertWindowsReleasePayload/);
  assert.equal(
    (packaging.match(/path\.join\(root, "THIRD_PARTY_NOTICES\.md"\)/g) || []).length,
    2,
  );
  assert.match(packaging, /third_party_licenses", "BUN-1\.3\.14-LICENSE\.md/);
  assert.match(packaging, /third_party_licenses", "UV-0\.11\.14-LICENSE-MIT/);
  assert.doesNotMatch(packaging, /runtime\.json/);
});

test("tag releases publish macOS, Windows, and Linux assets with one canonical checksum manifest", () => {
  const ciWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8");
  for (const runner of ["macos-15", "windows-latest", "ubuntu-latest"]) {
    assert.match(workflow, new RegExp(runner));
  }
  assert.match(workflow, /artifacts\/\*\.exe/);
  assert.match(ciWorkflow, /windows-smoke-installer\.ps1/);
  assert.match(workflow, /windows-smoke-installer\.ps1/);
  assert.match(workflow, /--use-mock-keychain --verify-packaged-renderer/);
  assert.match(workflow, /tags: \["v\*"\]/);
  assert.match(ciWorkflow, /bun-version: 1\.3\.14/);
  assert.match(workflow, /bun-version: 1\.3\.14/);
  assert.match(workflow, /version: "0\.11\.14"/);
  assert.match(workflow, /engine-installer\/uv/);
  assert.match(workflow, /updater-runtime\/bun" --version/);
  assert.match(workflow, /submodules: recursive/);
  assert.match(workflow, /git -C engine\/vendor\/seed-vc rev-parse HEAD/);
  assert.match(workflow, /cp THIRD_PARTY_NOTICES\.md release-assets\/THIRD_PARTY_NOTICES\.md/);
  assert.match(workflow, /BUN-1\.3\.14-LICENSE\.md/);
  assert.match(workflow, /UV-0\.11\.14-LICENSE-MIT/);
  assert.match(workflow, /REACT-19-LICENSE/);
  assert.doesNotMatch(workflow, /MS-PL-LICENSE/);
  assert.doesNotMatch(workflow, /voices\/licenses/);
  assert.match(workflow, /SHA256SUMS/);
  assert.match(workflow, /SHA256SUMS\.sig/);
  assert.match(workflow, /UPDATE_SIGNING_PRIVATE_KEY/);
  assert.match(workflow, /openssl pkeyutl -sign -rawin/);
  assert.match(workflow, /environment: release-signing/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /--draft/);
  assert.match(workflow, /--generate-notes/);
});

test("packaged Electron disables unsafe runtime switches and validates its ASAR", () => {
  assert.equal(packageJson.build.asar, true);
  assert.equal(packageJson.build.afterPack, "scripts/apply-electron-fuses.cjs");
  const fuseHook = fs.readFileSync(path.join(root, packageJson.build.afterPack), "utf8");
  assert.match(fuseHook, /strictlyRequireAllFuses:\s*true/);
  assert.match(fuseHook, /await flipFuses\(electronPath/);
  assert.doesNotMatch(fuseHook, /packager\.addElectronFuses/);
  assert.match(fuseHook, /FuseV1Options\.RunAsNode\]:\s*false/);
  assert.match(fuseHook, /FuseV1Options\.EnableEmbeddedAsarIntegrityValidation\]:\s*true/);
  assert.match(fuseHook, /FuseV1Options\.OnlyLoadAppFromAsar\]:\s*true/);
  assert.match(fuseHook, /FuseV1Options\.GrantFileProtocolExtraPrivileges\]:\s*false/);
  assert.match(fuseHook, /FuseV1Options\.WasmTrapHandlers\]:\s*true/);
  for (const unusedKey of [
    "NSMicrophoneUsageDescription",
    "NSCameraUsageDescription",
    "NSBluetoothAlwaysUsageDescription",
    "NSBluetoothPeripheralUsageDescription",
    "NSAppTransportSecurity",
  ]) assert.equal(fuseHook.includes(unusedKey), true);
});
