#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Opt-in, offline audio comparisons using the exact installed Seed-VC weights.

Run with runtime/seed-vc/.venv/bin/python. This measures the converter, not the
native capture/playback route. It deliberately keeps experiments out of the app.
"""

from __future__ import annotations

import argparse
from contextlib import redirect_stdout
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import time
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
PROFILES = ("current", "lookahead-180", "lookahead-320", "block-600", "block-1200", "prompt-6", "whole-utterance", "vocoder-reconstruction")


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=Path, required=True, help="JSON manifest of local test recordings")
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--runtime-root", type=Path, default=ROOT / "runtime/seed-vc")
    parser.add_argument("--worker-file", type=Path, default=ROOT / "engine/seed-vc/worker.py", help="Explicit worker revision for before/after regression comparisons")
    parser.add_argument("--profiles", nargs="+", choices=PROFILES, default=list(PROFILES))
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--vocoder-dir", type=Path, help="Explicit experimental BigVGAN directory with a SHA-256 manifest")
    parser.add_argument("--acoustic-model-dir", type=Path, help="Explicit offline Seed-VC small / Whisper experiment")
    parser.add_argument("--steps", type=int, choices=range(4, 51), default=10)
    parser.add_argument("--prompt-seconds", type=float, default=3.0)
    parser.add_argument("--vocoder-precision", choices=("fp16", "fp32"), default="fp16")
    parser.add_argument("--diffusion-precision", choices=("fp16", "fp32"), default="fp16")
    parser.add_argument("--device", choices=("mps", "cuda"), default="mps")
    args = parser.parse_args()
    args.sources = args.sources.resolve(strict=True)
    args.reference = args.reference.resolve(strict=True)
    args.runtime_root = args.runtime_root.resolve(strict=True)
    args.worker_file = args.worker_file.resolve(strict=True)
    args.output = args.output.resolve()
    if args.vocoder_dir:
        args.vocoder_dir = args.vocoder_dir.resolve(strict=True)
    if args.acoustic_model_dir:
        args.acoustic_model_dir = args.acoustic_model_dir.resolve(strict=True)
        if not args.vocoder_dir:
            parser.error("--acoustic-model-dir requires its matching --vocoder-dir")
    if not 1 <= args.prompt_seconds <= 15:
        parser.error("--prompt-seconds must be between 1 and 15")
    args.output.mkdir(parents=True, exist_ok=False)
    manifest = json.loads(args.sources.read_text())
    sources = []
    source_ids = set()
    for entry in manifest["sources"]:
        if not re.fullmatch(r"[a-z0-9]+(?:[-_][a-z0-9]+)*", entry["id"]) or entry["id"] in source_ids:
            raise ValueError("Source ids must be unique safe filename components")
        source_ids.add(entry["id"])
        file = (args.sources.parent / entry["path"]).resolve(strict=True)
        if digest(file) != entry["sha256"]:
            raise ValueError(f"Source digest mismatch: {file}")
        sources.append((entry, file))
    if not sources:
        raise ValueError("The source manifest is empty")
    engine_root = ROOT / "engine/seed-vc"
    spec = importlib.util.spec_from_file_location("cpv_worker", args.worker_file)
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    if args.device == "mps":
        runtime_profile, requirements = "darwin-arm64-mps", "requirements-macos-arm64.lock.txt"
    elif sys.platform == "win32":
        runtime_profile, requirements = "windows-x64-cuda130", "requirements-windows-x64-cuda.lock.txt"
    else:
        runtime_profile, requirements = "linux-x64-cuda130", "requirements-linux-x64-cuda.lock.txt"
    engine_args = SimpleNamespace(
        runtime_root=args.runtime_root, seed_root=ROOT / "engine/vendor/seed-vc",
        runtime_profile=runtime_profile, device=args.device,
        source_rate=48_000, source_channels=1, steps=args.steps, block_ms=300,
        prompt_seconds=3.0, style_seconds=17.0,
    )
    lock, artifacts = worker.verify_model_artifacts(
        args.runtime_root, engine_root / "model-lock.json", runtime_profile, engine_root / requirements,
    )
    worker.configure_environment(args.runtime_root)
    upstream, models, torch, load_seconds, device_info = worker.load_upstream(engine_args, lock, artifacts)
    import librosa
    import numpy as np
    import soundfile as sf

    vocoder_manifest = None
    acoustic_manifest = None
    if args.vocoder_dir:
        vocoder_manifest = json.loads((args.vocoder_dir / "manifest.json").read_text())
        for filename in ("config.json", "bigvgan_generator.pt"):
            if digest(args.vocoder_dir / filename) != vocoder_manifest["files"][filename]:
                raise ValueError(f"Experimental vocoder digest mismatch: {filename}")
        from modules.bigvgan.bigvgan import BigVGAN
        from modules.bigvgan.env import AttrDict
        config = json.loads((args.vocoder_dir / "config.json").read_text())
        if args.acoustic_model_dir:
            import yaml
            acoustic_manifest = json.loads((args.acoustic_model_dir / "manifest.json").read_text())
            for filename, expected in acoustic_manifest["files"].items():
                if digest(args.acoustic_model_dir / filename) != expected:
                    raise ValueError(f"Experimental acoustic-model digest mismatch: {filename}")
            acoustic_config = yaml.safe_load((args.acoustic_model_dir / "config_dit_mel_seed_uvit_whisper_small_wavenet.yml").read_text())
            acoustic_config["model_params"]["speech_tokenizer"]["name"] = str(args.acoustic_model_dir / "whisper")
            acoustic_config["model_params"]["vocoder"]["name"] = str(args.vocoder_dir)
            generated_config = args.output / "acoustic-config.yml"
            generated_config.write_text(yaml.safe_dump(acoustic_config, sort_keys=False))
            models = upstream.load_models(SimpleNamespace(
                checkpoint_path=str(args.acoustic_model_dir / "DiT_seed_v2_uvit_whisper_small_wavenet_bigvgan_pruned.pth"),
                config_path=str(generated_config), fp16=True,
            ))
        for field in ("num_mels", "n_fft", "hop_size", "win_size", "sampling_rate", "fmin", "fmax"):
            expected = models[-1][field]
            actual = config[field]
            if field == "fmax" and expected is None:
                expected = models[-1]["sampling_rate"] / 2
            if field == "fmax" and actual is None:
                actual = config["sampling_rate"] / 2
            if actual != expected:
                raise ValueError(f"Vocoder mel contract mismatch: {field}: {actual} != {expected}")
        if not args.acoustic_model_dir:
            vocoder = BigVGAN(AttrDict(config), use_cuda_kernel=False)
            checkpoint = torch.load(args.vocoder_dir / "bigvgan_generator.pt", map_location="cpu", weights_only=True)
            vocoder.load_state_dict(checkpoint["generator"], strict=True)
            vocoder.remove_weight_norm()
            vocoder.eval().to(upstream.device)
            models = (models[0], models[1], vocoder, *models[3:])

    reference_bytes = args.reference.read_bytes()
    if args.diffusion_precision == "fp32":
        original_diffusion = models[0].cfm.inference

        def fp32_diffusion(*inputs, **kwargs):
            with torch.autocast(device_type=args.device, enabled=False):
                return original_diffusion(*inputs, **kwargs)

        models[0].cfm.inference = fp32_diffusion
    if args.vocoder_precision == "fp32":
        original_vocoder = models[2]

        def fp32_vocoder(mel):
            with torch.autocast(device_type=args.device, enabled=False):
                return original_vocoder(mel.float())

        models = (models[0], models[1], fp32_vocoder, *models[3:])
    report = {
        "schemaVersion": 1, "scope": "offline converter comparison; excludes source discard and native route",
        "modelLockSha256": digest(engine_root / "model-lock.json"),
        "workerFile": str(args.worker_file), "workerSha256": digest(args.worker_file),
        "benchmarkSha256": digest(Path(__file__)),
        "reference": str(args.reference), "referenceSha256": digest(args.reference),
        "sourcesManifestSha256": digest(args.sources), "seed": args.seed,
        "device": device_info, "loadSeconds": load_seconds, "cases": [],
        "experimentalVocoder": vocoder_manifest,
        "experimentalAcousticModel": acoustic_manifest,
        "vocoderPrecision": args.vocoder_precision,
        "diffusionPrecision": args.diffusion_precision,
    }
    for profile in args.profiles:
        engine_args.prompt_seconds = 6.0 if profile == "prompt-6" else args.prompt_seconds
        engine_args.block_ms = {"block-600": 600, "block-1200": 1200}.get(profile, 300)
        converter = worker.StreamingConverter(upstream, models, torch, engine_args, reference_bytes)
        right_ms = {"lookahead-180": 180, "lookahead-320": 320, "block-600": 180, "block-1200": 180}.get(profile, 20)
        if right_ms != 20:
            # Change only future context. Output size, models and diffusion steps remain identical.
            converter.extra_right_frame = round(right_ms / 20) * converter.zc
            converter.skip_tail = converter.extra_right_frame // converter.zc
            converter.input_wav = torch.zeros(
                converter.extra_frame + converter.crossfade_frame + converter.sola_search_frame
                + converter.block_frame + converter.extra_right_frame,
                device=converter.device, dtype=torch.float32,
            )
        torch.manual_seed(args.seed)
        warmup_seconds = converter.warmup()
        for entry, file in sources:
            converter.reset()
            torch.manual_seed(args.seed)
            source, rate = sf.read(file, dtype="float32", always_2d=True)
            if not 0.06 <= len(source) / rate <= 30:
                raise ValueError(f"Test recordings must be between 0.06 and 30 seconds: {file}")
            if not np.isfinite(source).all():
                raise ValueError(f"Non-finite test audio: {file}")
            source = source.mean(axis=1)
            timings, output = [], []
            started = time.perf_counter()
            if profile == "vocoder-reconstruction":
                # Control: decode the source's real mel, without conversion or speaker conditioning.
                source22 = librosa.resample(source, orig_sr=rate, target_sr=converter.sample_rate)
                with torch.no_grad(), torch.autocast(device_type=args.device, dtype=torch.float16):
                    mel = converter.to_mel(torch.from_numpy(source22).to(converter.device)[None])
                    output.append(converter.vocoder_fn(mel).squeeze().float().cpu().numpy())
            elif profile == "whole-utterance":
                # Same model, conditioning and vocoder, with access to the entire recording.
                source16 = librosa.resample(source, orig_sr=rate, target_sr=16_000)
                source22 = librosa.resample(source, orig_sr=rate, target_sr=converter.sample_rate)
                with torch.no_grad(), redirect_stdout(sys.stderr):
                    semantics = converter.semantic_fn(torch.from_numpy(source16).to(converter.device)[None])
                    frames = converter.to_mel(torch.from_numpy(source22).to(converter.device)[None]).shape[-1]
                    condition = converter.model.length_regulator(
                        semantics, ylens=torch.tensor([frames], device=converter.device), n_quantizers=3, f0=None,
                    )[0]
                    combined = torch.cat([converter.prompt_condition, condition], dim=1)
                    with torch.autocast(device_type=args.device, dtype=torch.float16):
                        mel = converter.model.cfm.inference(
                            combined, torch.tensor([combined.shape[1]], device=converter.device),
                            converter.prompt_mel, converter.reference_style, None,
                            n_timesteps=args.steps, inference_cfg_rate=0.7,
                        )[:, :, converter.prompt_mel.shape[-1]:]
                        result = converter.vocoder_fn(mel).squeeze().float().cpu().numpy()
                output.append(result)
            else:
                pcm = librosa.resample(source, orig_sr=rate, target_sr=48_000)
                # Leading silence exposes startup behavior. Flush enough zeros to retain the final word.
                lead_samples, tail_samples = 48_000, 48_000
                pcm = np.pad(pcm, (lead_samples, tail_samples))
                block = converter.source_block_frame
                pcm = np.pad(pcm, (0, (-len(pcm)) % block))
                for offset in range(0, len(pcm), block):
                    body, metrics = converter.convert(pcm[offset:offset + block].astype("<f4").tobytes())
                    output.append(np.frombuffer(body, dtype="<f4"))
                    if not metrics["silent"]:
                        timings.append(metrics["elapsedMs"])
                result = np.concatenate(output)
                # Keep the same one-second margins for audition; do not hide startup or tail defects.
            worker.synchronize_device(torch, converter.device)
            wall_seconds = time.perf_counter() - started
            offline_profile = profile in ("whole-utterance", "vocoder-reconstruction")
            result = np.concatenate(output) if offline_profile else result
            if not np.isfinite(result).all() or not len(result):
                raise RuntimeError(f"Invalid generated audio: {profile}/{entry['id']}")
            output_name = f"{entry['id']}--{profile}.wav"
            sf.write(args.output / output_name, result, converter.sample_rate, subtype="FLOAT")
            case = {
                "sourceId": entry["id"], "language": entry["language"], "transcript": entry["transcript"],
                "profile": profile, "rightContextMs": None if offline_profile else right_ms,
                "blockMs": None if offline_profile else engine_args.block_ms,
                "promptSeconds": engine_args.prompt_seconds, "diffusionSteps": args.steps,
                "warmupSeconds": warmup_seconds, "sourceSeconds": len(source) / rate,
                "outputSeconds": len(result) / converter.sample_rate, "wallSeconds": wall_seconds,
                "inferenceP50Ms": float(np.percentile(timings, 50)) if timings else None,
                "inferenceP95Ms": float(np.percentile(timings, 95)) if timings else None,
                "inferenceMeanMs": float(np.mean(timings)) if timings else None,
                "peak": float(np.max(np.abs(result))), "rms": float(np.sqrt(np.mean(result ** 2))),
                "output": output_name, "outputSha256": digest(args.output / output_name),
                **converter.memory_metrics(),
            }
            report["cases"].append(case)
            (args.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
            print(json.dumps(case, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
