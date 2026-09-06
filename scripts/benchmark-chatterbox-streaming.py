#!/usr/bin/env python3
"""Feed 20 ms live-paced PCM into the experimental bounded Chatterbox converter."""
import argparse
from dataclasses import asdict
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--sources', type=Path, required=True)
parser.add_argument('--reference', type=Path, required=True)
parser.add_argument('--weights', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--block-ms', type=int, default=320)
parser.add_argument('--initial-block-ms', type=int, default=0)
parser.add_argument('--lookahead-ms', type=int, default=240)
parser.add_argument('--prompt-seconds', type=float, default=3)
parser.add_argument('--steps', type=int, default=10)
parser.add_argument('--precision', choices=['fp32', 'fp16'], default='fp32')
parser.add_argument('--paced', action='store_true')
parser.add_argument('--device', choices=['mps', 'cuda'], default='mps')
parser.add_argument('--backend', choices=['torch', 'mlx'], default='torch')
args = parser.parse_args()
if not 1 <= args.prompt_seconds <= 10:
    parser.error('prompt-seconds must be between 1 and 10')
args.output.mkdir(parents=True, exist_ok=False)

import librosa
import numpy as np
import soundfile as sf
import torch
torch.set_num_threads(1)
torch.set_num_interop_threads(1)
from safetensors.torch import load_file

spec = importlib.util.spec_from_file_location('cpv_chatterbox_stream', ROOT / 'engine/chatterbox/streaming.py')
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()

checkpoint = json.loads((args.weights / 'manifest.json').read_text())
for name, sha in checkpoint['files'].items():
    if digest(args.weights / name) != sha:
        raise ValueError(f'Model digest mismatch: {name}')
if args.backend == 'torch' and args.device == 'mps' and not torch.backends.mps.is_available():
    raise RuntimeError('MPS is unavailable')
if args.device == 'cuda' and not torch.cuda.is_available():
    raise RuntimeError('CUDA is unavailable')
started = time.perf_counter()
torch.manual_seed(42)
config = module.StreamConfig(block_ms=args.block_ms, initial_block_ms=args.initial_block_ms, lookahead_ms=args.lookahead_ms, steps=args.steps, precision=args.precision)
if args.backend == 'mlx':
    if args.device != 'mps':
        parser.error('The MLX executor requires Metal')
    import perth
    backend_spec = importlib.util.spec_from_file_location('cpv_mlx', ROOT / 'engine/chatterbox/mlx_backend.py')
    backend_module = importlib.util.module_from_spec(backend_spec)
    backend_spec.loader.exec_module(backend_module)
    backend = backend_module.MlxChatterbox(args.weights)
    wave, _ = librosa.load(args.reference, sr=24000)
    reference = backend.prepare_reference(wave, args.prompt_seconds)
    stream = module.MlxStreamingChatterbox(backend, reference, perth.PerthImplicitWatermarker(), config)
else:
    from chatterbox.models.s3gen import S3Gen
    from chatterbox.vc import ChatterboxVC
    model = S3Gen()
    status = model.load_state_dict(load_file(args.weights / 's3gen.safetensors'), strict=False)
    if set(status.missing_keys) - set(model.ignore_state_dict_missing) or status.unexpected_keys:
        raise RuntimeError(f'Unmatched checkpoint: {status}')
    model.eval().to(args.device)
    voice = ChatterboxVC(model, args.device)
    voice.set_target_voice(str(args.reference))
    reference = dict(voice.ref_dict)
    prompt_tokens = min(reference['prompt_token'].shape[-1], round(args.prompt_seconds * 25))
    reference['prompt_token'] = reference['prompt_token'][:, :prompt_tokens]
    reference['prompt_token_len'] = torch.tensor([prompt_tokens], device=args.device)
    reference['prompt_feat'] = reference['prompt_feat'][:, :prompt_tokens * 2]
    stream = module.StreamingChatterbox(model, reference, voice.watermarker, config)
prompt_tokens = reference['prompt_token'].shape[1]
stream.synchronize()
prepare_seconds = time.perf_counter() - started
started = time.perf_counter()
stream.warmup()
warmup_seconds = time.perf_counter() - started
report = {
    'schemaVersion': 1, 'scope': 'Bounded streaming converter with 20 ms source packets; excludes native capture and playback',
    'paced': args.paced, 'checkpoint': checkpoint, 'config': asdict(config),
    'promptSeconds': prompt_tokens / 25, 'speakerEmbeddingSeconds': 10,
    'referenceSha256': digest(args.reference), 'sourcesManifestSha256': digest(args.sources),
    'streamImplementationSha256': digest(ROOT / 'engine/chatterbox/streaming.py'),
    'benchmarkSha256': digest(Path(__file__)), 'torch': torch.__version__, 'device': args.device, 'backend': args.backend,
    'prepareSeconds': prepare_seconds, 'warmupSeconds': warmup_seconds, 'cases': [],
}
if args.backend == 'mlx':
    import mlx.core as mx
    report.update(mlx=mx.__version__, mlxBackendSha256=digest(ROOT / 'engine/chatterbox/mlx_backend.py'))
print(json.dumps({k: report[k] for k in ['config', 'prepareSeconds', 'warmupSeconds']}), flush=True)
for entry in json.loads(args.sources.read_text())['sources']:
    source = args.sources.parent / entry['path']
    if digest(source) != entry['sha256']:
        raise ValueError(f'Source digest mismatch: {source}')
    samples, rate = sf.read(source, dtype='float32', always_2d=True)
    samples = samples.mean(axis=1)
    samples = librosa.resample(samples, orig_sr=rate, target_sr=16000, res_type='soxr_hq')
    stream.reset()
    outputs, trace = [], []
    started = time.perf_counter()

    def record(emitted):
        for audio, metrics in emitted:
            ready = time.perf_counter() - started
            metrics = {**metrics, 'readySeconds': ready,
                       'audioStartDelayMs': (ready - metrics['sourceStartSample'] / 16000) * 1000}
            trace.append(metrics)
            outputs.append(audio)
            if len(trace) % 8 == 0:
                print(json.dumps({'sourceId': entry['id'], 'blocks': len(trace), 'last': metrics}), flush=True)

    for offset in range(0, len(samples), 320):
        chunk = samples[offset:offset + 320]
        if args.paced:
            deadline = started + (offset + len(chunk)) / 16000
            delay = deadline - time.perf_counter()
            if delay > 0:
                time.sleep(delay)
        record(stream.push(chunk))
    record(stream.finish())
    output = np.concatenate(outputs)
    if len(output) != len(samples) * 3 // 2 or not np.isfinite(output).all():
        raise RuntimeError('Streaming output lost, duplicated, or corrupted samples')
    filename = f"{entry['id']}--streaming.wav"
    sf.write(args.output / filename, output, 24000, subtype='FLOAT')
    live = [t for t in trace if not t['final']]
    timings = [t['elapsedMs'] for t in live]
    case = {
        'sourceId': entry['id'], 'profile': 'streaming', 'output': filename,
        'outputSha256': digest(args.output / filename), 'outputSeconds': len(output) / 24000,
        'wallSeconds': time.perf_counter() - started,
        'firstOutputSeconds': trace[0]['readySeconds'],
        'firstOutputObservedInputSeconds': trace[0]['observedInputSamples'] / 16000,
        'inferenceMeanMs': float(np.mean(timings)), 'inferenceP95Ms': float(np.percentile(timings, 95)),
        'p95AudioStartDelayMs': float(np.percentile([t['audioStartDelayMs'] for t in live], 95)) if args.paced else None,
        'computeRtf': float(np.mean(timings)) / config.block_ms,
        'maxBufferedInputSamples': max(t['bufferSamples'] for t in trace),
        'peak': float(np.max(np.abs(output))), 'trace': trace,
    }
    report['cases'].append(case)
    (args.output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: v for k, v in case.items() if k != 'trace'}), flush=True)
