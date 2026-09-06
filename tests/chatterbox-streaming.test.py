"""Streaming contract tests; run with the Chatterbox evaluation interpreter."""
import importlib.util
from pathlib import Path
import sys
import unittest
import numpy as np

spec = importlib.util.spec_from_file_location('cpv_stream', Path(__file__).resolve().parents[1] / 'engine/chatterbox/streaming.py')
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


class SourceEcho(module.PcmStream):
    """Replace only the model with a time-preserving source echo."""
    def __init__(self, config=module.StreamConfig()):
        super().__init__(config)
        self.windows = []

    def _render(self, source):
        self.windows.append(source.copy())
        block = source[self.semantic_left:self.semantic_left + self.hop]
        return np.repeat(block, 3)[::2], {}


def feed(stream, signal):
    result = []
    for offset in range(0, len(signal), 320):
        result.extend(stream.push(signal[offset:offset + 320]))
    return result


class StreamingTests(unittest.TestCase):
    def test_emits_before_end_of_input_without_endpoint_detection(self):
        stream = SourceEcho()
        self.assertEqual(feed(stream, np.ones(8640, dtype=np.float32)), [])
        result = stream.push(np.ones(320, dtype=np.float32))
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0][1]['observedInputSamples'], 8960)
        self.assertFalse(result[0][1]['final'])
        self.assertEqual(len(result[0][0]), 7680)
        np.testing.assert_array_equal(stream.windows[0][:32000], np.zeros(32000))
        np.testing.assert_array_equal(stream.windows[0][32000:], np.ones(8960))

    def test_prefix_output_cannot_depend_on_unreceived_future(self):
        prefix = np.random.default_rng(7).normal(size=32000).astype(np.float32)
        a, b = SourceEcho(), SourceEcho()
        out_a, out_b = feed(a, prefix), feed(b, prefix.copy())
        feed(a, np.ones(16000, dtype=np.float32))
        feed(b, -np.ones(16000, dtype=np.float32))
        for (left, lm), (right, rm) in zip(out_a, out_b, strict=True):
            np.testing.assert_array_equal(left, right)
            self.assertEqual(lm['sourceStartSample'], rm['sourceStartSample'])

    def test_sample_accounting_and_memory_stay_bounded(self):
        signal = (np.arange(16000 * 30 + 17, dtype=np.float32) % 4096) / 4096
        stream = SourceEcho()
        result = feed(stream, signal)
        result.extend(stream.finish())
        actual = np.concatenate([audio for audio, _ in result])
        expected = np.repeat(signal, 3)[::2][:len(signal) * 3 // 2]
        np.testing.assert_array_equal(actual, expected)
        self.assertLessEqual(max(m['bufferSamples'] for _, m in result), stream.semantic_left + stream.hop + stream.right)
        self.assertEqual(sum(m['sourceSamples'] for _, m in result), len(signal))

    def test_lifecycle_and_packet_validation(self):
        stream = SourceEcho()
        with self.assertRaises(ValueError):
            stream.push(np.ones(641, dtype=np.float32))
        with self.assertRaises(ValueError):
            stream.push([np.nan])
        self.assertEqual(stream.finish(), [])
        with self.assertRaises(RuntimeError):
            stream.push([0])
        with self.assertRaises(RuntimeError):
            stream.finish()

    def test_small_initial_block_preserves_timing_and_exact_sample_accounting(self):
        config = module.StreamConfig(block_ms=400, initial_block_ms=160, lookahead_ms=160)
        stream = SourceEcho(config)
        signal = np.random.default_rng(3).normal(size=16000 * 5 + 11).astype(np.float32)
        result = feed(stream, signal)
        self.assertEqual(result[0][1]['observedInputSamples'], 5120)
        self.assertEqual(result[0][1]['sourceSamples'], 2560)
        self.assertEqual(result[1][1]['sourceStartSample'], 2560)
        self.assertEqual(result[1][1]['sourceSamples'], 6400)
        result.extend(stream.finish())
        expected = np.repeat(signal, 3)[::2][:len(signal) * 3 // 2]
        np.testing.assert_array_equal(np.concatenate([a for a, _ in result]), expected)

    def test_silence_preserves_clock_and_does_not_gate_quiet_speech(self):
        stream = SourceEcho()
        result = feed(stream, np.zeros(16000, dtype=np.float32))
        self.assertTrue(all(m['digitalSilence'] for _, m in result))
        self.assertFalse(stream.windows)
        result.extend(feed(stream, np.full(16000, 1e-9, dtype=np.float32)))
        result.extend(stream.finish())
        actual = np.concatenate([a for a, _ in result])
        np.testing.assert_array_equal(actual[:24000], np.zeros(24000))
        np.testing.assert_array_equal(actual[24000:], np.full(24000, 1e-9, dtype=np.float32))
        self.assertTrue(stream.windows)
        stream.reset()
        self.assertEqual(stream.received, 0)
        self.assertEqual(stream.next_start, 0)
        self.assertEqual(len(stream.buffer), 0)
        self.assertFalse(stream.finished)


if __name__ == '__main__':
    unittest.main()
