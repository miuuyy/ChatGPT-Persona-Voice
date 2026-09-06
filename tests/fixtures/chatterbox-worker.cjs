"use strict";
const { EngineMessageParser, encodeEngineMessage } = require("../../electron/engine-protocol.cjs");
const lock = require("../../engine/chatterbox/model-lock.json");
const requirementsSha256 = require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(require("node:path").join(__dirname, "../../engine/chatterbox/requirements-macos-arm64.lock.txt"))).digest("hex");
const arg = (key) => process.argv[process.argv.indexOf(key) + 1];
const send = (header, body) => {
  const packet = encodeEngineMessage(header, body);
  // Deliberately fragment headers to exercise real child-pipe framing.
  process.stdout.write(packet.subarray(0, 7));
  process.stdout.write(packet.subarray(7));
};
send({ type: "ready", protocolVersion: 1, engine: "chatterbox", profile: lock.profile,
       ...lock.output, ...lock.stream, sourceRate: +arg("--source-rate"), sourceChannels: +arg("--source-channels"),
       voiceSha256: arg("--voice-sha256"), modelSha256: lock.model.files["s3gen.safetensors"], requirementsSha256 });
let converts = 0;
const parser = new EngineMessageParser(({ header }) => {
  const { type, id } = header;
  if (type === "convert") {
    converts += 1;
    const count = process.env.CPV_TEST_MODE === "corrupt" || converts === 2 ? (lock.stream.initialBlockMs || lock.stream.blockMs) * 24 : converts > 2 ? lock.stream.blockMs * 24 : 0;
    const body = Buffer.alloc(count * 4);
    if (process.env.CPV_TEST_MODE === "corrupt") body.writeFloatLE(NaN, 0);
    const reply = () => send({ type: "result", id, ...lock.output, samplesPerChannel: count }, body);
    if (process.env.CPV_TEST_MODE === "delayed") setTimeout(reply, 30);
    else reply();
  } else if (type === "reset") {
    converts = 0;
    send({ type, id });
  } else if (type === "prime") send({ type, id, elapsedMs: 1 });
  else if (type === "shutdown") {
    send({ type, id });
    process.stdin.pause();
    process.exitCode = 0;
  }
});
process.stdin.on("data", (data) => parser.push(data));
