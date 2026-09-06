"use strict";

const path = require("node:path");
const { ChatterboxInstaller } = require("../electron/chatterbox-installer.cjs");
const { resolveChatterboxPaths } = require("../electron/chatterbox-runtime.cjs");
const { resolveEngineInstallerPaths } = require("../electron/engine-installer.cjs");

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--checkpoint" || !path.isAbsolute(args[1]))) {
  throw new Error("Usage: node scripts/setup-chatterbox.cjs [--checkpoint /absolute/path/s3gen.safetensors]");
}
const installer = new ChatterboxInstaller({
  paths: resolveChatterboxPaths(), uvPath: resolveEngineInstallerPaths().uvPath,
  checkpointPath: args[1] || null,
  publish: (state) => console.log(`${state.status}: ${state.detail}`),
  logger: { debug: (_event, data) => console.log(data.message) },
});
process.once("SIGINT", () => { void installer.cancel(); });
process.once("SIGTERM", () => { void installer.cancel(); });
installer.install().catch((error) => { console.error(error.message); process.exitCode = 1; });
