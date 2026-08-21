const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function sha256File(filePath) {
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(filePath, "r");
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      digest.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return digest.digest("hex");
}

const root = path.resolve(__dirname, "..");
const packageMetadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const executable = process.execPath;

function prepareUpdaterRuntime() {
  const expectedVersion = /^bun@(.+)$/.exec(packageMetadata.packageManager)?.[1];
  const actualVersion = process.versions.bun;
  if (!expectedVersion || actualVersion !== expectedVersion) {
    throw new Error(
      `Packaging requires Bun ${expectedVersion || "from packageManager"}; current runtime is ${actualVersion || "not Bun"}`,
    );
  }
  const runtimeRoot = path.join(root, "build", "updater-runtime");
  const runtimeName = process.platform === "win32" ? "bun.exe" : "bun";
  const runtimePath = path.join(runtimeRoot, runtimeName);
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o755 });
  fs.copyFileSync(process.execPath, runtimePath);
  if (process.platform !== "win32") fs.chmodSync(runtimePath, 0o755);
  fs.copyFileSync(
    path.join(root, "THIRD_PARTY_NOTICES.md"),
    path.join(runtimeRoot, "THIRD_PARTY_NOTICES.md"),
  );
  fs.copyFileSync(
    path.join(root, "third_party_licenses", "BUN-1.3.14-LICENSE.md"),
    path.join(runtimeRoot, "BUN-1.3.14-LICENSE.md"),
  );
}

function executableOnPath(name) {
  const explicit = process.env.CODEX_PERSONA_VOICE_UV_BIN?.trim();
  if (explicit) {
    if (!path.isAbsolute(explicit) || !fs.existsSync(explicit)) {
      throw new Error("CODEX_PERSONA_VOICE_UV_BIN must name an existing absolute executable");
    }
    return explicit;
  }
  for (const directory of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function prepareEngineInstallerRuntime() {
  const expectedVersion = packageMetadata.engineInstaller?.uvVersion;
  const runtimeName = process.platform === "win32" ? "uv.exe" : "uv";
  const executablePath = executableOnPath(runtimeName);
  if (!expectedVersion || !executablePath) {
    throw new Error(`${process.platform} packaging requires the pinned uv engine-installer bootstrap`);
  }
  const result = spawnSync(executablePath, ["--version"], {
    encoding: "utf8",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.stdout.trim().split(/\s+/)[1] !== expectedVersion) {
    throw new Error(
      `${process.platform} packaging requires uv ${expectedVersion}; found ${result.stdout.trim() || "unavailable"}`,
    );
  }
  const installerRoot = path.join(root, "build", "engine-installer");
  fs.rmSync(installerRoot, { recursive: true, force: true });
  fs.mkdirSync(installerRoot, { recursive: true, mode: 0o755 });
  const packagedRuntime = path.join(installerRoot, runtimeName);
  fs.copyFileSync(executablePath, packagedRuntime);
  if (process.platform !== "win32") fs.chmodSync(packagedRuntime, 0o755);
  fs.copyFileSync(
    path.join(root, "THIRD_PARTY_NOTICES.md"),
    path.join(installerRoot, "THIRD_PARTY_NOTICES.md"),
  );
  fs.copyFileSync(
    path.join(root, "third_party_licenses", "UV-0.11.14-LICENSE-MIT"),
    path.join(installerRoot, "UV-0.11.14-LICENSE-MIT"),
  );
}

const electronBuilderCli = require.resolve("electron-builder/out/cli/cli.js", { paths: [root] });
const requested = process.argv[2];
const target = requested || (process.platform === "darwin" ? "--mac"
  : process.platform === "win32" ? "--win"
    : process.platform === "linux" ? "--linux"
      : null);
if (!["--mac", "--win", "--linux"].includes(target)) {
  throw new Error(`Unsupported packaging target: ${requested || process.platform}`);
}
const nativeTarget = process.platform === "darwin" ? "--mac"
  : process.platform === "win32" ? "--win"
    : process.platform === "linux" ? "--linux"
      : null;
if (target !== nativeTarget) {
  throw new Error(
    `Cross-packaging ${target} from ${process.platform}/${process.arch} is disabled. `
    + "Audio permissions and native routing must be verified on the target operating system.",
  );
}
prepareUpdaterRuntime();
prepareEngineInstallerRuntime();
const artifactOs = target.slice(2);
const artifactPrefix = `codex-persona-voice-${packageMetadata.version}-${artifactOs}-`;

const env = { ...process.env };
if (!env.CSC_LINK && !env.CSC_NAME) env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
const builderArgs = [
  electronBuilderCli,
  target,
  "--publish",
  "never",
];
if (target === "--mac" && !env.CSC_LINK && !env.CSC_NAME) {
  builderArgs.push("--config.mac.identity=-");
  builderArgs.push("--config.mac.hardenedRuntime=false");
}

const staging = fs.mkdtempSync(path.join(os.tmpdir(), "codex-persona-voice-package-"));
const artifactsDirectory = path.join(root, "artifacts");
try {
  const result = spawnSync(executable, [
    ...builderArgs,
    `--config.directories.output=${staging}`,
  ], {
    cwd: root,
    env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);

  fs.mkdirSync(artifactsDirectory, { recursive: true });
  fs.rmSync(path.join(artifactsDirectory, "SHA256SUMS"), { force: true });
  for (const entry of fs.readdirSync(artifactsDirectory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith(artifactPrefix) &&
        /\.(?:AppImage|dmg|exe|zip|blockmap)$/i.test(entry.name)) {
      fs.rmSync(path.join(artifactsDirectory, entry.name), { force: true });
    }
  }
  const artifacts = fs.readdirSync(staging, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:AppImage|dmg|exe|zip|blockmap)$/i.test(entry.name));
  if (!artifacts.some((entry) => /\.(?:AppImage|dmg|exe|zip)$/i.test(entry.name))) {
    throw new Error(`electron-builder produced no distributable artifact in ${staging}`);
  }
  for (const artifact of artifacts) {
    const publicName = artifact.name.replace(/-linux-x86_64(?=\.)/, "-linux-x64");
    fs.copyFileSync(path.join(staging, artifact.name), path.join(artifactsDirectory, publicName));
  }
  const packagedArtifacts = fs.readdirSync(artifactsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:AppImage|dmg|exe|zip|blockmap)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const checksums = packagedArtifacts.map((name) => {
    const digest = sha256File(path.join(artifactsDirectory, name));
    return `${digest}  ${name}`;
  });
  fs.writeFileSync(path.join(artifactsDirectory, "SHA256SUMS"), `${checksums.join("\n")}\n`, {
    mode: 0o644,
  });
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
