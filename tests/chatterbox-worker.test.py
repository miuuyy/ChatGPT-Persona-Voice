"""Framing and streaming-resampler checks without loading neural weights."""
import importlib.util
import io
import json
from pathlib import Path
import struct
import unittest
from unittest.mock import patch
import numpy as np
import soxr

spec = importlib.util.spec_from_file_location('cpv_worker', Path(__file__).resolve().parents[1] / 'engine/chatterbox/worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class PacketSink:
    def reset(self):
        self.received = 0
        self.packets = []

    def push(self, samples):
        assert len(samples) <= 320
        self.received += len(samples)
        self.packets.append(samples.copy())
        return [(samples.copy(), {})]

    def finish(self):
        return []


class WorkerTests(unittest.TestCase):
    def test_runtime_drift_is_rejected_before_loading_models(self):
        with patch.object(worker.platform, 'python_version', return_value='3.11.13'):
            with self.assertRaisesRegex(RuntimeError, 'Python 3.11.14'):
                worker.verify_runtime()
        with patch.object(worker.importlib.metadata, 'version', return_value='0.0.0'):
            with self.assertRaisesRegex(RuntimeError, 'Unqualified runtime version'):
                worker.verify_runtime()

    def test_binary_roundtrip_and_corrupt_inputs(self):
        pipe = io.BytesIO()
        worker.send(pipe, {'type': 'convert', 'id': 1}, b'\0\1\2\3')
        packet = pipe.getvalue()
        self.assertEqual(worker.receive(io.BytesIO(packet)), ({'type': 'convert', 'id': 1}, b'\0\1\2\3'))
        for truncated in [packet[:3], packet[:-1]]:
            with self.assertRaises(EOFError):
                worker.receive(io.BytesIO(truncated))
        with self.assertRaises(ValueError):
            worker.receive(io.BytesIO(struct.pack('<4sII', b'CPVE', 65537, 0)))
        self.assertIsNone(worker.receive(io.BytesIO()))

    def test_resampling_is_continuous_across_packets_and_reset(self):
        pcm = np.random.default_rng(2).normal(size=(96000, 2)).astype(np.float32) * 0.1
        sink = PacketSink()
        stream = worker.InputStream(sink, 48000, 2)
        for _ in range(2):
            output = []
            for start in range(0, len(pcm), 960):
                output.extend(a for a, _ in stream.push(pcm[start:start + 960].astype('<f4').tobytes()))
            self.assertTrue(sink.packets)  # output exists before explicit finish
            output.extend(a for a, _ in stream.finish())
            result = np.concatenate(output)
            expected = soxr.resample(pcm.mean(axis=1), 48000, 16000, quality='HQ')
            self.assertEqual(len(result), 32000)
            np.testing.assert_allclose(result, expected, atol=2e-7, rtol=2e-5)
            with self.assertRaises(RuntimeError):
                stream.push(pcm[:960].tobytes())
            stream.reset()
            self.assertEqual(sink.received, 0)

    def test_input_validation_precedes_model_execution(self):
        sink = PacketSink()
        stream = worker.InputStream(sink, 16000, 1)
        for pcm in [b'x', b'', np.zeros(641, dtype='<f4').tobytes(), np.array([np.nan], dtype='<f4').tobytes()]:
            with self.assertRaises(ValueError):
                stream.push(pcm)
        self.assertEqual(sink.received, 0)


if __name__ == '__main__':
    unittest.main()
