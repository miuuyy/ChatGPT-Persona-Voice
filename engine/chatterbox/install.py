#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Acquire and verify the exact streaming runtime before publishing readiness."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys


def digest(file):
    with file.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def acquire_checkpoint(lock, weights, *, checkpoint=None, download=False):
    weights.mkdir(parents=True, exist_ok=True)
    model = weights / 's3gen.safetensors'
    expected = lock['model']['files'][model.name]
    if model.exists() and digest(model) == expected:
        return model
    if checkpoint:
        if digest(checkpoint) != expected:
            raise RuntimeError('Imported checkpoint does not match the pinned SHA-256')
        temporary = model.with_suffix('.downloading')
        shutil.copyfile(checkpoint, temporary)
    elif download:
        from huggingface_hub import hf_hub_download
        print('Downloading the pinned Chatterbox checkpoint; interrupted downloads can resume', flush=True)
        # Keep partial bytes and metadata inside owned staging. The pinned Hub
        # client handles the Hub/Xet protocol, resumption and server retry policy.
        temporary = Path(hf_hub_download(
            repo_id=lock['model']['repository'], revision=lock['model']['revision'],
            filename=model.name, local_dir=weights / '.download', token=False,
        ))
    else:
        raise RuntimeError('The pinned Chatterbox checkpoint is missing or corrupt')
    if digest(temporary) != expected:
        temporary.unlink()
        raise RuntimeError('Downloaded checkpoint SHA-256 mismatch; retry to download it again')
    os.replace(temporary, model)
    if (weights / '.download').exists():
        shutil.rmtree(weights / '.download')
    return model


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime-root', type=Path, required=True)
    parser.add_argument('--download', action='store_true')
    parser.add_argument('--checkpoint', type=Path)
    args = parser.parse_args()
    root = Path(__file__).parent
    spec = importlib.util.spec_from_file_location('chatterbox_worker', root / 'worker.py')
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    requirements_hash = worker.verify_runtime()
    import mlx.core as mx
    if not mx.metal.is_available():
        raise RuntimeError('Chatterbox requires the Apple Metal accelerator')
    mx.set_default_device(mx.gpu)
    value = mx.ones((16, 16)) @ mx.ones((16, 16))
    mx.eval(value)
    if float(value[0, 0].item()) != 16:
        raise RuntimeError('Metal tensor verification failed')
    lock_file = root / 'model-lock.json'
    lock = json.loads(lock_file.read_text())
    weights = args.runtime_root / 'weights'
    model = acquire_checkpoint(lock, weights, checkpoint=args.checkpoint, download=args.download)
    expected = lock['model']['files'][model.name]
    # Load every learned tensor and verify the local corrected graph mapping.
    sys.path.insert(0, str(root))
    from mlx_backend import MlxChatterbox
    backend = MlxChatterbox(weights)
    mx.eval(backend.model.parameters())
    receipt = {
        'schemaVersion': 1, 'profile': lock['profile'],
        'modelLockSha256': digest(lock_file), 'requirementsSha256': requirements_hash,
        'modelSha256': expected, 'modelBytes': model.stat().st_size,
    }
    manifest = args.runtime_root / 'install-manifest.json'
    temporary = manifest.with_suffix('.tmp')
    temporary.write_text(json.dumps(receipt, indent=2) + '\n')
    os.replace(temporary, manifest)
    print('Chatterbox runtime, accelerator, graph and checkpoint verified', flush=True)


if __name__ == '__main__':
    main()
