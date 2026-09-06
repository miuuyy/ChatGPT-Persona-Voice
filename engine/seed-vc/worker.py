#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Persistent GPL Seed-VC inference sidecar for Codex Persona Voice."""

from __future__ import annotations

import argparse
from contextlib import redirect_stdout
import hashlib
import io
import importlib.metadata
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import struct
import sys
import time
import traceback
from types import SimpleNamespace
from typing import BinaryIO


MAGIC = b"CPVE"
PREFIX = struct.Struct("<4sII")
MAX_HEADER_BYTES = 64 * 1024
MAX_BODY_BYTES = 4 * 1024 * 1024
MAX_VOICE_REFERENCE_BYTES = 16 * 1024 * 1024
RUNTIME_DISTRIBUTIONS = {
    "torch": "torch",
    "torchaudio": "torchaudio",
    "transformers": "transformers",
    "huggingface-hub": "huggingface-hub",
}
MIN_PROMPT_SECONDS = 1.0
MAX_PROMPT_SECONDS = 15.0
MIN_STYLE_SECONDS = 3.0
MAX_STYLE_SECONDS = 30.0
STYLE_DEVICE = "cpu"
RUNTIME_PROFILE_DEVICES = {
    "darwin-arm64-mps": "mps",
    "windows-x64-cuda130": "cuda",
    "linux-x64-cuda130": "cuda",
}
RUNTIME_PROFILE_BACKENDS = {
    "darwin-arm64-mps": "mps",
    "windows-x64-cuda130": "cu130",
    "linux-x64-cuda130": "cu130",
}
PROTOCOL_OUT: BinaryIO = sys.stdout.buffer
sys.stdout = sys.stderr


def send(header: dict[str, object], body: bytes = b"") -> None:
    encoded = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if not encoded or len(encoded) > MAX_HEADER_BYTES or len(body) > MAX_BODY_BYTES:
        raise RuntimeError("Outbound engine message exceeds protocol bounds")
    PROTOCOL_OUT.write(PREFIX.pack(MAGIC, len(encoded), len(body)))
    PROTOCOL_OUT.write(encoded)
    PROTOCOL_OUT.write(body)
    PROTOCOL_OUT.flush()


def read_exact(stream: BinaryIO, length: int) -> bytes | None:
    value = bytearray()
    while len(value) < length:
        chunk = stream.read(length - len(value))
        if not chunk:
            if not value:
                return None
            raise EOFError("Engine input ended inside a protocol frame")
        value.extend(chunk)
    return bytes(value)


def receive(stream: BinaryIO) -> tuple[dict[str, object], bytes] | None:
    prefix = read_exact(stream, PREFIX.size)
    if prefix is None:
        return None
    magic, header_bytes, body_bytes = PREFIX.unpack(prefix)
    if magic != MAGIC:
        raise RuntimeError("Engine input magic does not match CPVE")
    if not 0 < header_bytes <= MAX_HEADER_BYTES or body_bytes > MAX_BODY_BYTES:
        raise RuntimeError("Engine input length is outside protocol bounds")
    encoded = read_exact(stream, header_bytes)
    body = read_exact(stream, body_bytes)
    if encoded is None or body is None:
        raise EOFError("Engine input ended inside a protocol frame")
    header = json.loads(encoded.decode("utf-8"))
    if not isinstance(header, dict) or not isinstance(header.get("type"), str):
        raise RuntimeError("Engine input header is invalid")
    return header, body


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed-root", required=True, type=Path)
    parser.add_argument("--runtime-root", required=True, type=Path)
    parser.add_argument("--runtime-profile", required=True, choices=tuple(RUNTIME_PROFILE_DEVICES))
    parser.add_argument("--requirements-lock", required=True, type=Path)
    parser.add_argument("--device", required=True, choices=("mps", "cuda"))
    parser.add_argument("--voice", required=True, type=Path)
    parser.add_argument("--voice-sha256", required=True)
    parser.add_argument("--source-rate", required=True, type=int)
    parser.add_argument("--source-channels", required=True, type=int)
    parser.add_argument("--steps", type=int, default=10, choices=range(4, 13))
    parser.add_argument("--block-ms", type=int, default=300, choices=[180, 200, 240, 300])
    parser.add_argument("--prompt-seconds", type=float, default=3.0)
    parser.add_argument("--style-seconds", type=float, default=17.0)
    args = parser.parse_args()
    if RUNTIME_PROFILE_DEVICES[args.runtime_profile] != args.device:
        parser.error("--runtime-profile and --device do not identify the same qualified runtime")
    if not math.isfinite(args.prompt_seconds) or not MIN_PROMPT_SECONDS <= args.prompt_seconds <= MAX_PROMPT_SECONDS:
        parser.error(
            f"--prompt-seconds must be between {MIN_PROMPT_SECONDS:g} and {MAX_PROMPT_SECONDS:g}"
        )
    if not math.isfinite(args.style_seconds) or not MIN_STYLE_SECONDS <= args.style_seconds <= MAX_STYLE_SECONDS:
        parser.error(
            f"--style-seconds must be between {MIN_STYLE_SECONDS:g} and {MAX_STYLE_SECONDS:g}"
        )
    if not re.fullmatch(r"[0-9a-f]{64}", args.voice_sha256):
        parser.error("--voice-sha256 must be a lowercase SHA-256 digest")
    return args


def sha256(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def model_integrity_error(detail: str) -> RuntimeError:
    return RuntimeError(
        f"Seed-VC model integrity verification failed: {detail}. "
        "Reinstall the locked offline model cache with the documented engine setup flow."
    )


def safe_relative_path(value: object, label: str) -> Path:
    if not isinstance(value, str) or not value:
        raise model_integrity_error(f"model lock has an invalid {label}")
    path = Path(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        raise model_integrity_error(f"model lock has an unsafe {label}: {value!r}")
    return path


def locked_model_entries(lock: object) -> list[dict[str, object]]:
    if not isinstance(lock, dict) or lock.get("schemaVersion") != 1:
        raise model_integrity_error("model lock schema is unsupported")
    repositories = lock.get("repositories")
    if not isinstance(repositories, dict) or not repositories:
        raise model_integrity_error("model lock has no repositories")

    entries: list[dict[str, object]] = []
    for repo_id, repository in repositories.items():
        if (not isinstance(repo_id, str) or repo_id.count("/") != 1 or
                any(not part or part in (".", "..") for part in repo_id.split("/"))):
            raise model_integrity_error(f"model lock has an invalid repository: {repo_id!r}")
        if not isinstance(repository, dict):
            raise model_integrity_error(f"model lock has an invalid repository entry for {repo_id}")
        revision = repository.get("revision")
        if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
            raise model_integrity_error(f"model lock has an invalid revision for {repo_id}")
        cache = safe_relative_path(repository.get("cache"), f"cache path for {repo_id}")
        files = repository.get("files")
        if not isinstance(files, dict) or not files:
            raise model_integrity_error(f"model lock has no files for {repo_id}")
        for filename, digest in files.items():
            filename_path = safe_relative_path(filename, f"filename for {repo_id}")
            if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
                raise model_integrity_error(f"model lock has an invalid SHA-256 for {repo_id}/{filename}")
            entries.append({
                "repo": repo_id,
                "revision": revision,
                "cache": cache,
                "file": filename,
                "filename_path": filename_path,
                "sha256": digest,
            })
    return entries


def verify_model_artifacts(
    runtime_root: Path,
    lock_path: Path,
    runtime_profile: str,
    requirements_path: Path,
) -> tuple[dict[str, object], dict[tuple[str, str], Path]]:
    """Validate each locked Hugging Face snapshot file before importing model code."""
    try:
        lock_bytes = lock_path.read_bytes()
        lock = json.loads(lock_bytes.decode("utf-8"))
        manifest_path = runtime_root / "install-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise model_integrity_error(f"cannot read model lock or installation manifest ({error})") from error

    entries = locked_model_entries(lock)
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 2:
        raise model_integrity_error("installation manifest schema is unsupported")
    if manifest.get("runtimeProfile") != runtime_profile:
        raise model_integrity_error("installation manifest runtime profile does not match this host")
    try:
        requirements_digest = sha256(requirements_path.resolve(strict=True))
    except OSError as error:
        raise model_integrity_error(f"runtime requirements lock is missing ({error})") from error
    if manifest.get("requirementsSha256") != requirements_digest:
        raise model_integrity_error("installation manifest does not match the runtime requirements lock")
    if manifest.get("modelLockSha256") != hashlib.sha256(lock_bytes).hexdigest():
        raise model_integrity_error("installation manifest does not match the current model lock")
    if manifest.get("seedVcCommit") != lock.get("seedVcCommit"):
        raise model_integrity_error("installation manifest Seed-VC commit does not match the model lock")
    if manifest.get("python") != lock.get("python"):
        raise model_integrity_error("installation manifest Python version does not match the model lock")
    manifest_files = manifest.get("files")
    if not isinstance(manifest_files, list):
        raise model_integrity_error("installation manifest has no file list")

    expected = {(entry["repo"], entry["revision"], entry["file"]): entry for entry in entries}
    actual: dict[tuple[object, object, object], dict[str, object]] = {}
    for item in manifest_files:
        if not isinstance(item, dict):
            raise model_integrity_error("installation manifest has an invalid file entry")
        key = (item.get("repo"), item.get("revision"), item.get("file"))
        if key in actual:
            raise model_integrity_error(f"installation manifest repeats {key[0]}/{key[2]}")
        actual[key] = item
    if set(actual) != set(expected):
        raise model_integrity_error("installation manifest file list does not exactly match the model lock")

    artifact_paths: dict[tuple[str, str], Path] = {}
    model_root = runtime_root / "models"
    try:
        resolved_model_root = model_root.resolve(strict=True)
    except OSError as error:
        raise model_integrity_error(f"offline model cache is missing ({error})") from error
    for key, entry in expected.items():
        item = actual[key]
        expected_digest = entry["sha256"]
        expected_bytes = item.get("bytes")
        if item.get("sha256") != expected_digest or not isinstance(expected_bytes, int) or expected_bytes < 1:
            raise model_integrity_error(f"installation manifest metadata is invalid for {key[0]}/{key[2]}")

        cache_root = model_root / entry["cache"]
        repository_root = cache_root / f"models--{key[0].replace('/', '--')}"
        snapshot_path = repository_root / "snapshots" / key[1] / entry["filename_path"]
        try:
            resolved_cache_root = cache_root.resolve(strict=True)
            resolved_cache_root.relative_to(resolved_model_root)
            resolved_repository_root = repository_root.resolve(strict=True)
            resolved_repository_root.relative_to(resolved_cache_root)
            resolved = snapshot_path.resolve(strict=True)
        except OSError as error:
            raise model_integrity_error(f"offline cache is missing {key[0]}/{key[2]} ({error})") from error
        except ValueError as error:
            raise model_integrity_error(f"offline cache entry escapes the model cache for {key[0]}/{key[2]}") from error
        try:
            resolved.relative_to(resolved_repository_root)
        except ValueError as error:
            raise model_integrity_error(f"offline cache entry escapes its repository for {key[0]}/{key[2]}") from error
        if not resolved.is_file():
            raise model_integrity_error(f"offline cache entry is not a file for {key[0]}/{key[2]}")
        actual_bytes = resolved.stat().st_size
        if actual_bytes != expected_bytes:
            raise model_integrity_error(
                f"offline cache byte size mismatch for {key[0]}/{key[2]}: expected {expected_bytes}, found {actual_bytes}"
            )
        actual_digest = sha256(resolved)
        if actual_digest != expected_digest:
            raise model_integrity_error(
                f"offline cache SHA-256 mismatch for {key[0]}/{key[2]}: expected {expected_digest}, found {actual_digest}"
            )
        artifact_paths[(key[0], key[2])] = snapshot_path
    return lock, artifact_paths


def configure_environment(runtime_root: Path) -> None:
    model_root = runtime_root / "models"
    os.environ["HF_HOME"] = str(model_root / "huggingface")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    os.environ["OMP_NUM_THREADS"] = "4"


def validate_runtime_packages(expected: object, installed: dict[str, str]) -> None:
    if not isinstance(expected, dict) or set(expected) != set(RUNTIME_DISTRIBUTIONS):
        raise RuntimeError("Seed-VC model lock must pin the complete qualified runtime package set")
    if set(installed) != set(RUNTIME_DISTRIBUTIONS):
        raise RuntimeError("Seed-VC runtime package inventory is incomplete")
    for name in RUNTIME_DISTRIBUTIONS:
        required = expected[name]
        actual = installed[name].split("+")[0]
        if not isinstance(required, str) or actual != required:
            raise RuntimeError(f"{name} {required} is required, found {actual}")


def validate_device_profile(torch, device_name: str) -> dict[str, object]:
    """Prove the requested accelerator with a real operation; never select a fallback."""
    if device_name == "mps":
        if not torch.backends.mps.is_available():
            raise RuntimeError("Apple MPS is unavailable; the macOS realtime profile cannot start")
        device = torch.device("mps")
        probe = torch.ones((8, 8), dtype=torch.float32, device=device)
        float((probe @ probe).sum().item())
        torch.mps.synchronize()
        return {"device": "mps", "backend": "mps"}
    if device_name == "cuda":
        if not torch.cuda.is_available() or torch.cuda.device_count() < 1:
            raise RuntimeError(
                "NVIDIA CUDA is unavailable; Windows/Linux realtime mode requires a supported NVIDIA GPU and driver"
            )
        index = torch.cuda.current_device()
        device = torch.device("cuda", index)
        probe = torch.ones((8, 8), dtype=torch.float32, device=device)
        float((probe @ probe).sum().item())
        torch.cuda.synchronize(device)
        cuda_version = getattr(torch.version, "cuda", None)
        if not isinstance(cuda_version, str) or not re.fullmatch(r"\d+\.\d+", cuda_version):
            raise RuntimeError("PyTorch did not report a qualified CUDA runtime version")
        return {
            "device": "cuda",
            "backend": f"cu{cuda_version.replace('.', '')}",
            "cudaDeviceName": torch.cuda.get_device_name(index),
            "cudaCapability": list(torch.cuda.get_device_capability(index)),
        }
    raise RuntimeError(f"Unsupported realtime device profile: {device_name}")


def synchronize_device(torch, device) -> None:
    if device.type == "mps":
        torch.mps.synchronize()
    elif device.type == "cuda":
        torch.cuda.synchronize(device)
    else:
        raise RuntimeError(f"Unqualified Seed-VC inference device: {device.type}")


def load_upstream(
    args: argparse.Namespace,
    lock: dict[str, object],
    artifact_paths: dict[tuple[str, str], Path],
):
    expected = lock["packages"]
    installed = {
        name: importlib.metadata.version(distribution)
        for name, distribution in RUNTIME_DISTRIBUTIONS.items()
    }
    validate_runtime_packages(expected, installed)

    import huggingface_hub
    import torch
    import torchaudio
    import transformers
    import yaml
    validate_runtime_packages(expected, {
        "torch": torch.__version__,
        "torchaudio": torchaudio.__version__,
        "transformers": transformers.__version__,
        "huggingface-hub": huggingface_hub.__version__,
    })
    device_info = validate_device_profile(torch, args.device)
    if device_info["backend"] != RUNTIME_PROFILE_BACKENDS[args.runtime_profile]:
        raise RuntimeError(
            f"Seed-VC profile {args.runtime_profile} requires {RUNTIME_PROFILE_BACKENDS[args.runtime_profile]}, "
            f"found {device_info['backend']}"
        )

    seed_root = args.seed_root.resolve()
    module_path = seed_root / "real-time-gui.py"
    if not module_path.is_file():
        raise RuntimeError("Pinned Seed-VC source checkout is missing")
    os.chdir(seed_root)
    sys.path.insert(0, str(seed_root))
    spec = importlib.util.spec_from_file_location("cpv_seed_vc_upstream", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Pinned Seed-VC source could not be imported")
    upstream = importlib.util.module_from_spec(spec)
    with redirect_stdout(sys.stderr):
        spec.loader.exec_module(upstream)
    upstream.device = torch.device(args.device)

    repositories = lock["repositories"]
    wav_snapshot = artifact_paths[("facebook/wav2vec2-xls-r-300m", "config.json")].parent

    def local_model(repo_id: str, model_filename: str = "pytorch_model.bin", config_filename: str | None = None):
        repository = repositories.get(repo_id)
        if repository is None:
            raise RuntimeError(f"Unpinned model repository requested: {repo_id}")
        try:
            model_path = artifact_paths[(repo_id, model_filename)]
        except KeyError as error:
            raise RuntimeError(f"Unlocked model file requested: {repo_id}/{model_filename}") from error
        if config_filename is None:
            return str(model_path)
        try:
            config_path = artifact_paths[(repo_id, config_filename)]
        except KeyError as error:
            raise RuntimeError(f"Unlocked model file requested: {repo_id}/{config_filename}") from error
        config = yaml.safe_load(config_path.read_text(encoding="utf-8"))
        config["model_params"]["speech_tokenizer"]["name"] = str(wav_snapshot)
        generated = args.runtime_root.resolve() / "generated" / config_filename
        generated.parent.mkdir(parents=True, exist_ok=True)
        generated.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
        return str(model_path), str(generated)

    upstream.load_custom_model_from_hf = local_model
    started = time.perf_counter()
    with redirect_stdout(sys.stderr):
        model_set = upstream.load_models(SimpleNamespace(
            checkpoint_path=None,
            config_path=None,
            fp16=True,
        ))
    synchronize_device(torch, upstream.device)
    return upstream, model_set, torch, time.perf_counter() - started, device_info


class StreamingConverter:
    def __init__(
        self,
        upstream,
        model_set,
        torch,
        args: argparse.Namespace,
        reference_bytes: bytes,
    ):
        import librosa
        import numpy as np
        import torch.nn.functional as functional

        self.upstream = upstream
        self.model_set = model_set
        self.torch = torch
        self.functional = functional
        self.librosa = librosa
        self.np = np
        self.device = upstream.device
        (
            self.model,
            self.semantic_fn,
            self.vocoder_fn,
            self.campplus_model,
            self.to_mel,
            self.mel_fn_args,
        ) = model_set
        self.source_rate = args.source_rate
        self.source_channels = args.source_channels
        self.steps = args.steps
        self.prompt_seconds = args.prompt_seconds
        self.style_seconds = args.style_seconds
        self.sample_rate = self.mel_fn_args["sampling_rate"]
        self.hop_length = self.mel_fn_args["hop_size"]
        self.zc = self.sample_rate // 50
        self.block_frame = round(args.block_ms / 1000 * self.sample_rate / self.zc) * self.zc
        self.source_block_frame = round(args.block_ms / 1000 * self.source_rate)
        self.crossfade_frame = round(0.04 * self.sample_rate / self.zc) * self.zc
        self.sola_buffer_frame = min(self.crossfade_frame, 4 * self.zc)
        self.sola_search_frame = self.zc
        self.extra_frame = round(2.5 * self.sample_rate / self.zc) * self.zc
        self.extra_right_frame = round(0.02 * self.sample_rate / self.zc) * self.zc
        total = (
            self.extra_frame + self.crossfade_frame + self.sola_search_frame
            + self.block_frame + self.extra_right_frame
        )
        self.input_wav = torch.zeros(total, device=self.device, dtype=torch.float32)
        self.sola_buffer = torch.zeros(self.sola_buffer_frame, device=self.device, dtype=torch.float32)
        self.fade_in = torch.sin(
            0.5 * np.pi * torch.linspace(
                0.0, 1.0, steps=self.sola_buffer_frame, device=self.device, dtype=torch.float32,
            )
        ) ** 2
        self.fade_out = 1 - self.fade_in
        self.skip_head = self.extra_frame // self.zc
        self.skip_tail = self.extra_right_frame // self.zc
        self.return_length = (
            self.block_frame + self.sola_buffer_frame + self.sola_search_frame
        ) // self.zc
        self.expected_input_bytes = self.source_block_frame * self.source_channels * 4
        self.reference, _ = librosa.load(io.BytesIO(reference_bytes), sr=self.sample_rate, mono=True)
        self.style_seconds_used = min(
            self.style_seconds,
            self.reference.shape[0] / self.sample_rate,
        )
        self.prompt_condition, self.prompt_mel, self.reference_style = self._prepare_reference()
        self.hangover_blocks = 0

    def _prepare_reference(self):
        prompt_samples = max(1, min(
            self.reference.shape[0],
            round(self.sample_rate * self.prompt_seconds),
        ))
        style_samples = max(1, min(
            self.reference.shape[0],
            round(self.sample_rate * self.style_seconds),
        ))
        prompt_tensor = self.torch.from_numpy(self.reference[:prompt_samples]).to(self.device)
        style_tensor = self.torch.from_numpy(self.reference[:style_samples])
        with self.torch.no_grad(), redirect_stdout(sys.stderr):
            prompt_16k = self.upstream.torchaudio.functional.resample(
                prompt_tensor,
                self.sample_rate,
                16_000,
            )
            prompt_semantics = self.semantic_fn(prompt_16k.unsqueeze(0))
            prompt_mel = self.to_mel(prompt_tensor.unsqueeze(0))
            prompt_lengths = self.torch.LongTensor([prompt_mel.size(2)]).to(prompt_mel.device)
            prompt_condition = self.model.length_regulator(
                prompt_semantics,
                ylens=prompt_lengths,
                n_quantizers=3,
                f0=None,
            )[0]

            style_16k = self.upstream.torchaudio.functional.resample(
                style_tensor,
                self.sample_rate,
                16_000,
            )
            style_features = self.upstream.torchaudio.compliance.kaldi.fbank(
                style_16k.unsqueeze(0),
                num_mel_bins=80,
                dither=0,
                sample_frequency=16_000,
            )
            style_features = style_features - style_features.mean(dim=0, keepdim=True)
            self.campplus_model.to(STYLE_DEVICE)
            reference_style = self.campplus_model(style_features.unsqueeze(0)).to(self.device)
        return prompt_condition, prompt_mel, reference_style

    def reset(self) -> None:
        self.input_wav.zero_()
        self.sola_buffer.zero_()
        self.hangover_blocks = 0

    def memory_metrics(self) -> dict[str, int]:
        metrics: dict[str, int] = {}
        if self.device.type == "mps":
            for key, method_name in (
                ("mpsCurrentAllocatedBytes", "current_allocated_memory"),
                ("mpsDriverAllocatedBytes", "driver_allocated_memory"),
                ("mpsRecommendedMaxBytes", "recommended_max_memory"),
            ):
                method = getattr(self.torch.mps, method_name, None)
                if callable(method):
                    try:
                        metrics[key] = int(method())
                    except Exception:
                        pass
        elif self.device.type == "cuda":
            metrics["cudaAllocatedBytes"] = int(self.torch.cuda.memory_allocated(self.device))
            metrics["cudaReservedBytes"] = int(self.torch.cuda.memory_reserved(self.device))
        return metrics

    def _update_input(self, body: bytes):
        np = self.np
        if len(body) != self.expected_input_bytes:
            raise RuntimeError(
                f"PCM block must contain {self.expected_input_bytes} bytes, received {len(body)}"
            )
        values = np.frombuffer(body, dtype="<f4")
        if not np.isfinite(values).all():
            raise RuntimeError("PCM block contains non-finite samples")
        mono = values.reshape(-1, self.source_channels).mean(axis=1, dtype=np.float32)
        rms = float(np.sqrt(np.mean(np.square(mono, dtype=np.float64))))
        resampled = self.librosa.resample(
            mono, orig_sr=self.source_rate, target_sr=self.sample_rate, res_type="soxr_hq",
        )
        resampled = self.librosa.util.fix_length(resampled, size=self.block_frame)
        self.input_wav[:-self.block_frame] = self.input_wav[self.block_frame:].clone()
        self.input_wav[-self.block_frame:] = self.torch.from_numpy(resampled).to(self.device)
        return rms

    def _infer(self):
        context_16k = self.librosa.resample(
            self.input_wav.detach().cpu().numpy(),
            orig_sr=self.sample_rate,
            target_sr=16_000,
            res_type="soxr_hq",
        )
        expected = 320 * self.input_wav.shape[0] // self.zc
        context_16k = self.librosa.util.fix_length(context_16k, size=expected)
        tensor = self.torch.from_numpy(context_16k).to(self.device)
        with self.torch.no_grad(), redirect_stdout(sys.stderr):
            converted_semantics = self.semantic_fn(tensor.unsqueeze(0))
            context_difference = 2 * 50
            converted_semantics = converted_semantics[:, context_difference:]
            target_length = int(
                (self.skip_head + self.return_length + self.skip_tail - context_difference)
                / 50 * self.sample_rate // self.hop_length
            )
            condition = self.model.length_regulator(
                converted_semantics,
                ylens=self.torch.LongTensor([target_length]).to(converted_semantics.device),
                n_quantizers=3,
                f0=None,
            )[0]
            combined = self.torch.cat([self.prompt_condition, condition], dim=1)
            with self.torch.autocast(device_type=self.device.type, dtype=self.torch.float16):
                converted_mel = self.model.cfm.inference(
                    combined,
                    self.torch.LongTensor([combined.size(1)]).to(self.prompt_mel.device),
                    self.prompt_mel,
                    self.reference_style,
                    None,
                    n_timesteps=self.steps,
                    inference_cfg_rate=0.7,
                )
                converted_mel = converted_mel[:, :, self.prompt_mel.size(-1):]
                converted_wave = self.vocoder_fn(converted_mel).squeeze().float()
            output_length = self.return_length * self.sample_rate // 50
            tail_length = self.skip_tail * self.sample_rate // 50
            return converted_wave[-output_length - tail_length:-tail_length]

    def warmup(self) -> float:
        started = time.perf_counter()
        self._infer()
        synchronize_device(self.torch, self.device)
        elapsed = time.perf_counter() - started
        self.reset()
        return elapsed

    def convert(self, body: bytes) -> tuple[bytes, dict[str, object]]:
        started = time.perf_counter()
        rms = self._update_input(body)
        # Capture volume does not determine whether a block contains speech.
        # Only digital silence can skip inference without discarding quiet words.
        has_audio = rms > 0.0
        if has_audio:
            self.hangover_blocks = 2
        elif self.hangover_blocks > 0:
            self.hangover_blocks -= 1
        should_infer = has_audio or self.hangover_blocks > 0
        if not should_infer:
            self.sola_buffer.zero_()
            output = self.np.zeros(self.block_frame, dtype="<f4")
        else:
            infer_wav = self._infer()
            conv_input = infer_wav[None, None, :self.sola_buffer_frame + self.sola_search_frame]
            numerator = self.functional.conv1d(conv_input, self.sola_buffer[None, None, :])
            denominator = self.torch.sqrt(self.functional.conv1d(
                conv_input**2,
                self.torch.ones(1, 1, self.sola_buffer_frame, device=self.device),
            ) + 1e-8)
            correlation = numerator[0, 0] / denominator[0, 0]
            offset = int(self.torch.max(correlation, dim=0).indices.item()) if correlation.numel() > 1 else 0
            infer_wav = infer_wav[offset:]
            required = self.block_frame + self.sola_buffer_frame
            if infer_wav.numel() < required:
                raise RuntimeError("Seed-VC returned a truncated streaming block")
            infer_wav[:self.sola_buffer_frame] *= self.fade_in
            infer_wav[:self.sola_buffer_frame] += self.sola_buffer * self.fade_out
            self.sola_buffer[:] = infer_wav[
                self.block_frame:self.block_frame + self.sola_buffer_frame
            ]
            output_tensor = self.torch.nan_to_num(
                infer_wav[:self.block_frame], nan=0.0, posinf=1.0, neginf=-1.0,
            ).clamp(-1.0, 1.0)
            output = output_tensor.float().cpu().numpy().astype("<f4", copy=False)
        synchronize_device(self.torch, self.device)
        return output.tobytes(), {
            "sampleRate": self.sample_rate,
            "channels": 1,
            "sampleFormat": "f32le",
            "samplesPerChannel": self.block_frame,
            "elapsedMs": round((time.perf_counter() - started) * 1000, 2),
            "inputRms": round(rms, 6),
            "silent": not should_infer,
            **self.memory_metrics(),
        }


def run() -> None:
    args = parse_args()
    if sys.byteorder != "little":
        raise RuntimeError("The CPVE f32le sidecar requires a little-endian host")
    if sys.version_info[:2] != (3, 11):
        raise RuntimeError(f"Python 3.11 is required, found {sys.version.split()[0]}")
    if args.source_rate < 8_000 or args.source_rate > 192_000 or args.source_channels not in (1, 2):
        raise RuntimeError("Source audio format is unsupported")
    if not args.voice.is_file():
        raise RuntimeError("Selected voice reference is missing")
    reference_bytes = args.voice.read_bytes()
    if not reference_bytes or len(reference_bytes) > MAX_VOICE_REFERENCE_BYTES:
        raise RuntimeError("Selected voice reference is outside the supported size bound")
    if hashlib.sha256(reference_bytes).hexdigest() != args.voice_sha256:
        raise RuntimeError("Selected voice reference failed its worker-bound SHA-256 check")
    runtime_root = args.runtime_root.resolve()
    lock_path = Path(__file__).with_name("model-lock.json")
    lock, artifact_paths = verify_model_artifacts(
        runtime_root,
        lock_path,
        args.runtime_profile,
        args.requirements_lock,
    )
    configure_environment(runtime_root)
    send({
        "type": "status",
        "stage": "loading",
        "detail": f"Loading Seed-VC on {args.device.upper()}",
    })
    upstream, model_set, torch, load_seconds, device_info = load_upstream(
        args, lock, artifact_paths,
    )
    converter = StreamingConverter(upstream, model_set, torch, args, reference_bytes)
    send({"type": "status", "stage": "warming", "detail": "Compiling the realtime inference path"})
    warmup_seconds = converter.warmup()
    send({
        "type": "ready",
        "protocolVersion": 1,
        "engine": "seed-vc-tiny-realtime",
        "runtimeProfile": args.runtime_profile,
        **device_info,
        "sampleRate": converter.sample_rate,
        "channels": 1,
        "sampleFormat": "f32le",
        "sourceBlockFrames": converter.source_block_frame,
        "outputBlockFrames": converter.block_frame,
        "steps": converter.steps,
        "promptSeconds": converter.prompt_seconds,
        "styleSeconds": converter.style_seconds,
        "styleSecondsUsed": round(converter.style_seconds_used, 3),
        "styleDevice": STYLE_DEVICE,
        "loadSeconds": round(load_seconds, 2),
        "warmupSeconds": round(warmup_seconds, 2),
        "torch": torch.__version__,
        **converter.memory_metrics(),
    })

    stream = sys.stdin.buffer
    while True:
        message = receive(stream)
        if message is None:
            return
        header, body = message
        request_id = header.get("id")
        command = header["type"]
        try:
            if command == "convert":
                if not isinstance(request_id, int) or request_id < 1:
                    raise RuntimeError("Convert request id is invalid")
                output, metadata = converter.convert(body)
                send({"type": "result", "id": request_id, **metadata}, output)
            elif command == "prime":
                if body:
                    raise RuntimeError("Prime request cannot contain a body")
                elapsed_seconds = converter.warmup()
                send({
                    "type": "prime",
                    "id": request_id,
                    "elapsedMs": round(elapsed_seconds * 1000, 2),
                })
            elif command == "reset":
                if body:
                    raise RuntimeError("Reset request cannot contain a body")
                converter.reset()
                send({"type": "reset", "id": request_id})
            elif command == "shutdown":
                if body:
                    raise RuntimeError("Shutdown request cannot contain a body")
                converter.reset()
                send({"type": "shutdown", "id": request_id})
                os._exit(0)
            else:
                raise RuntimeError(f"Unsupported engine command: {command}")
        except Exception as error:
            send({
                "type": "error",
                "id": request_id,
                "fatal": True,
                "message": str(error),
            })
            traceback.print_exc(file=sys.stderr)
            os._exit(1)


if __name__ == "__main__":
    try:
        run()
    except Exception as error:
        try:
            send({"type": "error", "id": None, "fatal": True, "message": str(error)})
        except Exception:
            pass
        traceback.print_exc(file=sys.stderr)
        os._exit(1)
