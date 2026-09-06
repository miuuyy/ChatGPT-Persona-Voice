#!/usr/bin/env python3
"""Export original S3Gen golden tensors, then validate the MLX execution graph.

Run export in the official Chatterbox environment and check in the MLX runtime.
No checkpoints or private voice references are downloaded by this script.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import time
import numpy as np

ROOT = Path(__file__).resolve().parents[1]


def digest(file):
    with file.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def export(args):
    import librosa
    import torch
    from safetensors.torch import load_file
    from chatterbox.models.s3gen import S3Gen
    from chatterbox.vc import ChatterboxVC
    if not args.source or not args.reference:
        raise ValueError('Export requires --source and --reference')
    args.fixtures.mkdir(parents=True, exist_ok=False)
    lock = json.loads((ROOT / 'engine/chatterbox/model-lock.json').read_text())
    checkpoint = args.weights / 's3gen.safetensors'
    if digest(checkpoint) != lock['model']['files']['s3gen.safetensors']:
        raise ValueError('Unmatched original checkpoint')
    if not torch.backends.mps.is_available():
        raise RuntimeError('Golden export requires the original MPS execution profile')
    torch.manual_seed(42)
    model = S3Gen()
    result = model.load_state_dict(load_file(checkpoint), strict=False)
    if result.unexpected_keys or set(result.missing_keys) - set(model.ignore_state_dict_missing):
        raise ValueError(f'Unmatched original weights: {result}')
    model.eval().to('mps')
    voice = ChatterboxVC(model, 'mps')
    voice.set_target_voice(str(args.reference))
    ref = dict(voice.ref_dict)
    n = min(ref['prompt_token'].shape[1], 75)
    ref.update(prompt_token=ref['prompt_token'][:, :n], prompt_token_len=torch.tensor([n], device='mps'),
               prompt_feat=ref['prompt_feat'][:, :n * 2])
    source, _ = librosa.load(args.source, sr=16000)
    if len(source) < 42240:
        raise ValueError('Golden source must contain at least 2.64 seconds')
    files = {}
    with torch.inference_mode():
        for index, start in enumerate([0, 32000]):
            waveform = np.pad(source[max(0, start - 32000):start + 10240], (max(0, 32000 - start), 0))
            all_tokens, _ = model.tokenizer(torch.from_numpy(waveform).to('mps')[None])
            tokens = all_tokens[:, -32:]
            noise = np.random.default_rng(42).standard_normal((1, 80, n * 2 + 64), dtype=np.float32)
            mel = model(tokens, ref_wav=None, ref_sr=None, ref_dict=ref, finalize=True, skip_vocoder=True,
                        n_cfm_timesteps=10, noised_mels=torch.from_numpy(noise).to('mps'))
            wave, excitation = model.hift_inference(mel)
            f0 = model.mel2wav.f0_predictor(mel)
            arrays = {key: value.cpu().numpy() for key, value in {
                'all_tokens': all_tokens, 'tokens': tokens, 'mel': mel, 'wave': wave, 'excitation': excitation, 'f0': f0,
                **{f'ref_{k}': ref[k] for k in ['prompt_token', 'prompt_token_len', 'prompt_feat', 'embedding']},
            }.items()}
            file = args.fixtures / f'window-{index}.npz'
            np.savez(file, waveform=waveform, noise=noise, **arrays)
            files[file.name] = digest(file)
    (args.fixtures / 'manifest.json').write_text(json.dumps({
        'checkpointSha256': digest(checkpoint), 'torch': torch.__version__, 'device': 'mps', 'steps': 10,
        'promptSeconds': n / 25, 'referenceSha256': digest(args.reference), 'sourceSha256': digest(args.source), 'files': files,
    }, indent=2) + '\n')


def check(args):
    spec = importlib.util.spec_from_file_location('cpv_mlx_backend', ROOT / 'engine/chatterbox/mlx_backend.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    backend = module.MlxChatterbox(args.weights)
    mx = backend.mx
    manifest = json.loads((args.fixtures / 'manifest.json').read_text())
    if digest(args.weights / 's3gen.safetensors') != manifest['checkpointSha256']:
        raise ValueError('Golden tensors use a different checkpoint')
    rows = []
    for name, expected_hash in manifest['files'].items():
        file = args.fixtures / name
        if digest(file) != expected_hash:
            raise ValueError(f'Golden fixture digest mismatch: {name}')
        fixture = np.load(file, allow_pickle=False)
        ref = {k[4:]: fixture[k] for k in fixture.files if k.startswith('ref_')}
        tokens = backend.tokenize(fixture['waveform'])
        if not np.array_equal(tokens, fixture['all_tokens']):
            raise AssertionError(f'{name}: speech token IDs changed')
        start = time.perf_counter()
        mel = backend.mel(fixture['tokens'], ref, fixture['noise'], manifest['steps'])
        mx.eval(mel)
        row = {'fixture': name, 'tokenMismatches': 0, 'melSeconds': time.perf_counter() - start}
        for key, value in [
            ('mel', mel), ('f0', backend.model.mel2wav.f0_predictor(mx.array(fixture['mel']))),
            ('wave', backend.decode(mx.array(fixture['mel']), mx.array(fixture['excitation']))),
        ]:
            actual, expected = np.asarray(value), fixture[key]
            if actual.shape != expected.shape:
                raise AssertionError(f'{name}: {key} shape differs')
            error = actual - expected
            relative = float(np.linalg.norm(error) / max(np.linalg.norm(expected), 1e-12))
            row[key] = {'relativeL2': relative, 'maxAbs': float(np.max(np.abs(error)))}
            if relative > 1e-4:
                raise AssertionError(f'{name}: {key} relative error {relative} exceeds 1e-4')
        rows.append(row)
        print(json.dumps(row), flush=True)
    if args.output:
        with args.output.open('x') as handle:
            json.dump({'scope': 'Numeric execution parity, not listening acceptance', 'cases': rows}, handle, indent=2)
            handle.write('\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['export', 'check'])
    parser.add_argument('--weights', required=True, type=Path)
    parser.add_argument('--fixtures', required=True, type=Path)
    parser.add_argument('--source', type=Path)
    parser.add_argument('--reference', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    export(args) if args.mode == 'export' else check(args)
