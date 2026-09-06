"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

test("worker preserves quiet input, drains overlap, and skips only digital silence", () => {
  const python = process.env.CPV_TEST_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const result = spawnSync(python, ["-c", `
import importlib.util
import sys
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("worker", sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

class InferenceReached(Exception):
    pass

class Buffer:
    def __init__(self):
        self.cleared = False
    def zero_(self):
        self.cleared = True

class SilentOutput:
    def tobytes(self):
        return bytes(6615 * 4)

converter = object.__new__(worker.StreamingConverter)
converter.hangover_blocks = 0
converter.block_frame = 6615
converter.sample_rate = 22050
converter.device = SimpleNamespace(type="mps")
converter.torch = SimpleNamespace(mps=SimpleNamespace(synchronize=lambda: None))
converter.sola_buffer = Buffer()
converter.input_wav = Buffer()
converter.np = SimpleNamespace(zeros=lambda *a, **k: SilentOutput())

def infer():
    # The neural model is outside this control-flow test. Reaching it proves
    # the worker did not replace a real block with zeros.
    raise InferenceReached()

converter._infer = infer

def convert(rms, expected_inference):
    converter._update_input = lambda body: rms
    try:
        pcm, metrics = converter.convert(b"input")
    except InferenceReached:
        assert expected_inference, "Digital silence unnecessarily reached the model"
    else:
        assert not expected_inference, "Nonzero input was discarded as silence"
        assert pcm == bytes(6615 * 4)
        assert metrics["silent"] is True
        assert converter.sola_buffer.cleared

convert(0.0, False)
for rms in (0.1, 0.001, 0.00001, 1.401298464324817e-45):
    convert(rms, True)
    convert(0.0, True)  # Retain the delayed end of the previous source block.
    convert(0.0, False)
convert(0.00001, True)
converter.reset()
assert converter.input_wav.cleared
convert(0.0, False)
`, path.join(__dirname, "..", "engine", "seed-vc", "worker.py")], { encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
});
