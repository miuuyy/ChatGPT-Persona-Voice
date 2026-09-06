#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""CPVE sidecar for bounded Chatterbox audio conversion on Apple Silicon.

This worker consumes PCM as it arrives. Only an explicit finish command ends
the stream; pauses never cause utterance buffering or sentence detection.
"""
import argparse
import hashlib
import importlib.metadata
import io
import json
import os
from pathlib import Path
import platform
import struct
import sys
import time

PREFIX = struct.Struct('<4sII')
MAX_HEADER = 65536
MAX_BODY = 4 * 1024 * 1024


def verify_runtime():
    if platform.python_version() != '3.11.14':
        raise RuntimeError('Chatterbox requires the qualified Python 3.11.14 runtime')
    lock_file = Path(__file__).with_name('requirements-macos-arm64.lock.txt')
    for requirement in lock_file.read_text().splitlines():
        if not requirement or requirement.startswith('#'):
            continue
        if '==' in requirement:
            name, version = requirement.split('==', 1)
            if importlib.metadata.version(name) != version:
                raise RuntimeError(f'Unqualified runtime version for {name}; expected {version}')
        elif ' @ git+' in requirement:
            name, location = requirement.split(' @ git+', 1)
            url, revision = location.rsplit('@', 1)
            installed = json.loads(importlib.metadata.distribution(name).read_text('direct_url.json') or '{}')
            if installed.get('url') != url or installed.get('vcs_info', {}).get('commit_id') != revision:
                raise RuntimeError(f'{name} is not installed from the locked Git revision')
        else:
            raise RuntimeError(f'Unsupported runtime lock entry: {requirement}')
    return hashlib.sha256(lock_file.read_bytes()).hexdigest()


def read_exact(pipe, count, eof=False):
    result = bytearray()
    while len(result) < count:
        part = pipe.read(count - len(result))
        if not part:
            if eof and not result:
                return None
            raise EOFError('Truncated CPVE message')
        result.extend(part)
    return bytes(result)


def receive(pipe):
    prefix = read_exact(pipe, PREFIX.size, eof=True)
    if prefix is None:
        return None
    magic, header_size, body_size = PREFIX.unpack(prefix)
    if magic != b'CPVE' or not 0 < header_size <= MAX_HEADER or body_size > MAX_BODY:
        raise ValueError('Invalid CPVE prefix or message size')
    header = json.loads(read_exact(pipe, header_size))
    if not isinstance(header, dict) or not isinstance(header.get('type'), str):
        raise ValueError('Invalid CPVE header')
    return header, read_exact(pipe, body_size)


def send(pipe, header, body=b''):
    encoded = json.dumps(header, allow_nan=False, separators=(',', ':')).encode()
    if not 0 < len(encoded) <= MAX_HEADER or len(body) > MAX_BODY:
        raise ValueError('Outbound CPVE message exceeds its bound')
    pipe.write(PREFIX.pack(b'CPVE', len(encoded), len(body)) + encoded + body)
    pipe.flush()


class InputStream:
    def __init__(self, converter, rate, channels):
        if not 8000 <= rate <= 96000 or channels not in (1, 2):
            raise ValueError('Unsupported source format')
        self.converter, self.rate, self.channels = converter, rate, channels
        self.reset()

    def reset(self):
        import soxr
        self.converter.reset()
        self.resampler = None if self.rate == 16000 else soxr.ResampleStream(self.rate, 16000, 1, dtype='float32', quality='HQ')
        self.received = 0
        self.finished = False

    def _feed(self, mono):
        outputs = []
        for start in range(0, len(mono), 320):
            outputs.extend(self.converter.push(mono[start:start + 320]))
        return outputs

    def push(self, body):
        import numpy as np
        if self.finished:
            raise RuntimeError('Cannot convert after finish without reset')
        count, remainder = divmod(len(body), 4 * self.channels)
        if remainder or not 0 < count <= self.rate * 40 // 1000:
            raise ValueError('Input must contain one finite PCM packet of at most 40 ms')
        pcm = np.frombuffer(body, dtype='<f4').reshape(-1, self.channels)
        if not np.isfinite(pcm).all():
            raise ValueError('Input PCM contains non-finite samples')
        mono = pcm.mean(axis=1)
        self.received += count
        if self.resampler is not None:
            mono = self.resampler.resample_chunk(mono)
        return self._feed(mono)

    def finish(self):
        import numpy as np
        if self.finished:
            raise RuntimeError('Stream already finished')
        result = [] if self.resampler is None else self._feed(self.resampler.resample_chunk(np.empty(0, dtype=np.float32), last=True))
        result.extend(self.converter.finish())
        self.finished = True
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--weights', required=True, type=Path)
    parser.add_argument('--voice', required=True, type=Path)
    parser.add_argument('--voice-sha256', required=True)
    parser.add_argument('--source-rate', required=True, type=int)
    parser.add_argument('--source-channels', required=True, type=int)
    args = parser.parse_args()
    output = sys.stdout.buffer
    sys.stdout = sys.stderr
    current_id = None
    try:
        if platform.system() != 'Darwin' or platform.machine() != 'arm64':
            raise RuntimeError('This profile requires Apple Silicon and Metal')
        requirements_hash = verify_runtime()
        # -I removes script/cwd imports; only this trusted engine directory is added.
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        os.environ.update(HF_HUB_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1', PYTORCH_ENABLE_MPS_FALLBACK='0')
        import librosa
        import numpy as np
        import perth
        import soundfile as sf
        import torch
        torch.set_num_threads(1)
        torch.set_num_interop_threads(1)
        from mlx_backend import MlxChatterbox
        from streaming import MlxStreamingChatterbox, StreamConfig
        lock = json.loads(Path(__file__).with_name('model-lock.json').read_text())
        settings = lock['stream']
        if not 0 < args.voice.stat().st_size <= 16 * 1024 * 1024:
            raise ValueError('Reference exceeds the 16 MiB bound')
        reference_bytes = args.voice.read_bytes()
        if hashlib.sha256(reference_bytes).hexdigest() != args.voice_sha256:
            raise ValueError('Voice reference digest mismatch')
        wave, rate = sf.read(io.BytesIO(reference_bytes), dtype='float32', always_2d=True)
        wave = librosa.resample(wave.mean(axis=1), orig_sr=rate, target_sr=24000)
        send(output, {'type': 'status', 'state': 'loading', 'engine': 'chatterbox'})
        backend = MlxChatterbox(args.weights)
        reference = backend.prepare_reference(wave, settings['promptSeconds'])
        config = StreamConfig(block_ms=settings['blockMs'], initial_block_ms=settings['initialBlockMs'], lookahead_ms=settings['lookaheadMs'], steps=settings['steps'])
        converter = MlxStreamingChatterbox(backend, reference, perth.PerthImplicitWatermarker(), config)
        converter.warmup()
        source = InputStream(converter, args.source_rate, args.source_channels)
        send(output, {'type': 'ready', 'protocolVersion': 1, 'engine': 'chatterbox', 'profile': lock['profile'],
                      **lock['output'], **settings, 'sourceRate': args.source_rate, 'sourceChannels': args.source_channels,
                      'requirementsSha256': requirements_hash,
                      'voiceSha256': args.voice_sha256, 'modelSha256': lock['model']['files']['s3gen.safetensors']})
        previous_id = 0
        while (message := receive(sys.stdin.buffer)) is not None:
            header, body = message
            current_id = header.get('id')
            if type(current_id) is not int or not previous_id < current_id <= 2147483647:
                raise ValueError('Request ids must be strictly increasing positive integers')
            previous_id = current_id
            command = header['type']
            if command != 'convert' and body:
                raise ValueError('Control messages cannot contain PCM')
            started = time.perf_counter()
            if command in ('convert', 'finish'):
                emitted = source.push(body) if command == 'convert' else source.finish()
                audio = np.concatenate([a for a, _ in emitted]) if emitted else np.empty(0, dtype=np.float32)
                send(output, {'type': 'result' if command == 'convert' else 'finished', 'id': current_id,
                              **lock['output'], 'samplesPerChannel': len(audio), 'elapsedMs': (time.perf_counter() - started) * 1000,
                              'sourceSamples': source.received, 'blocks': [m for _, m in emitted]}, audio.astype('<f4').tobytes())
            elif command == 'prime':
                if source.received or source.finished:
                    raise RuntimeError('Prime is only valid before input')
                converter.warmup()
                send(output, {'type': 'prime', 'id': current_id, 'elapsedMs': (time.perf_counter() - started) * 1000})
            elif command == 'reset':
                source.reset()
                send(output, {'type': 'reset', 'id': current_id})
            elif command == 'shutdown':
                source.reset()
                send(output, {'type': 'shutdown', 'id': current_id})
                return 0
            else:
                raise ValueError(f'Unknown CPVE command: {command}')
        return 0
    except Exception as error:
        send(output, {'type': 'error', 'id': current_id, 'message': str(error)})
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
