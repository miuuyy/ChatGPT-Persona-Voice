# SPDX-License-Identifier: MIT
"""Bounded audio-to-audio Chatterbox stream shared by the app and comparison tools.

Input arrives as 16 kHz mono float32 packets. The model sees only a fixed past
window and the explicitly declared lookahead. No utterance endpoint is used.
"""
from dataclasses import dataclass
import time


@dataclass(frozen=True)
class StreamConfig:
    block_ms: int = 320
    initial_block_ms: int = 0
    lookahead_ms: int = 240
    semantic_left_ms: int = 2000
    acoustic_left_ms: int = 640
    overlap_ms: int = 40
    search_ms: int = 20
    steps: int = 10
    precision: str = "fp32"
    seed: int = 42

    def __post_init__(self):
        for value in (self.block_ms, self.lookahead_ms, self.semantic_left_ms, self.acoustic_left_ms):
            if value <= 0 or value % 40:
                raise ValueError("Model context and block sizes must be positive multiples of 40 ms")
        if self.acoustic_left_ms > self.semantic_left_ms:
            raise ValueError("Acoustic history exceeds the available semantic history")
        if self.overlap_ms <= 0 or self.search_ms < 0 or self.overlap_ms + self.search_ms > self.lookahead_ms:
            raise ValueError("The declared lookahead must cover overlap and alignment search")
        if self.overlap_ms > self.block_ms:
            raise ValueError("Overlap must fit inside one emitted block")
        if self.initial_block_ms and (self.initial_block_ms % 40 or not self.overlap_ms <= self.initial_block_ms <= self.block_ms):
            raise ValueError("Initial block must fit the overlap and be a multiple of 40 ms no larger than the regular block")
        if self.precision not in ("fp32", "fp16") or not 1 <= self.steps <= 50:
            raise ValueError("Unsupported precision or diffusion step count")


class PcmStream:
    """Packet timing, bounded source history and output alignment shared by executors."""
    input_rate = 16000
    output_rate = 24000

    def __init__(self, config=StreamConfig()):
        import numpy as np
        self.np, self.config = np, config
        self.hop = config.block_ms * 16
        self.right = config.lookahead_ms * 16
        self.semantic_left = config.semantic_left_ms * 16
        self.acoustic_left_tokens = config.acoustic_left_ms // 40
        self.hop_tokens = config.block_ms // 40
        self.right_tokens = config.lookahead_ms // 40
        self.window_tokens = self.acoustic_left_tokens + self.hop_tokens + self.right_tokens
        self.maximum_window_tokens = self.window_tokens
        self.output_hop = config.block_ms * 24
        self.overlap = config.overlap_ms * 24
        self.search = config.search_ms * 24
        self.fade = np.sin(np.linspace(0, np.pi / 2, self.overlap, dtype=np.float32)) ** 2
        self.reset()

    def reset(self):
        self.received = self.next_start = self.buffer_start = 0
        self._select_hop()
        self.buffer = self.np.empty(0, dtype=self.np.float32)
        self.previous_overlap = None
        self.committed_tokens = None
        self.finished = False

    def _select_hop(self):
        block_ms = self.config.initial_block_ms if self.next_start == 0 and self.config.initial_block_ms else self.config.block_ms
        self.hop = block_ms * 16
        self.hop_tokens = block_ms // 40
        self.window_tokens = self.acoustic_left_tokens + self.hop_tokens + self.right_tokens
        self.output_hop = block_ms * 24

    def _align(self, wav):
        np = self.np
        if not np.isfinite(wav).all():
            raise RuntimeError("Chatterbox returned non-finite audio")
        begin = self.config.acoustic_left_ms * 24
        wav = np.asarray(wav[begin:], dtype=np.float32)
        offset = 0
        if self.previous_overlap is not None:
            candidate = wav[:self.overlap + self.search]
            numerator = np.correlate(candidate, self.previous_overlap, mode="valid")
            energy = np.convolve(candidate ** 2, np.ones(self.overlap, dtype=np.float32), mode="valid")
            offset = int(np.argmax(numerator / np.sqrt(energy + 1e-8)))
        wav = wav[offset:]
        if len(wav) < self.output_hop + self.overlap:
            raise RuntimeError("Vocoder returned a truncated streaming window")
        output = wav[:self.output_hop].copy()
        if self.previous_overlap is not None:
            output[:self.overlap] = output[:self.overlap] * self.fade + self.previous_overlap * (1 - self.fade)
        self.previous_overlap = wav[self.output_hop:self.output_hop + self.overlap].copy()
        return output, {"alignmentOffsetSamples": offset}

    def _advance_context(self, tokens):
        self.committed_tokens = None

    def _silence(self):
        output = self.np.zeros(self.output_hop, dtype=self.np.float32)
        if self.previous_overlap is not None:
            output[:self.overlap] = self.previous_overlap * (1 - self.fade)
        self.previous_overlap = None
        self._advance_context(None)
        return output, {"digitalSilence": True, "alignmentOffsetSamples": 0}

    def warmup(self, count=2):
        # Compile both the initial and steady shapes before accepting source PCM.
        for initial in (True, False):
            self.next_start = 0 if initial else 1
            self._select_hop()
            blank = self.np.zeros(self.semantic_left + self.hop + self.right, dtype=self.np.float32)
            for _ in range(count):
                self._render(blank)
            if not self.config.initial_block_ms:
                break
        self.reset()

    def push(self, samples):
        if self.finished:
            raise RuntimeError("Cannot push after end of stream")
        samples = self.np.asarray(samples, dtype=self.np.float32)
        if samples.ndim != 1 or not self.np.isfinite(samples).all():
            raise ValueError("Expected finite mono PCM")
        # A packet bound prevents callers from turning this API into whole-file inference.
        if len(samples) > self.input_rate // 25:
            raise ValueError("Input packets must be at most 40 ms")
        self.buffer = self.np.concatenate((self.buffer, samples))
        self.received += len(samples)
        return self._drain(final=False)

    def finish(self):
        if self.finished:
            raise RuntimeError("Stream already finished")
        result = self._drain(final=True)
        self.finished = True
        return result

    def _drain(self, final):
        np = self.np
        results = []
        while self.next_start < self.received and (final or self.received >= self.next_start + self.hop + self.right):
            started = time.perf_counter()
            begin = self.next_start - self.semantic_left
            end = self.next_start + self.hop + self.right
            available_start = max(0, begin)
            available_end = min(self.received, end)
            window = self.buffer[available_start - self.buffer_start:available_end - self.buffer_start]
            window = np.pad(window, (available_start - begin, end - available_end))
            # Only exact digital silence is bypassed. Quiet speech is never gated.
            # The lookahead must also be silent, so an incoming onset is rendered.
            if np.any(window[self.semantic_left:] != 0):
                output, metrics = self._render(window)
            else:
                output, metrics = self._silence()
            valid_input = min(self.hop, self.received - self.next_start)
            output = output[:valid_input * 3 // 2]
            results.append((output, {
                **metrics, "sourceStartSample": self.next_start,
                "sourceSamples": valid_input, "observedInputSamples": self.received,
                "elapsedMs": (time.perf_counter() - started) * 1000,
                "bufferSamples": len(self.buffer), "final": final,
            }))
            self.next_start += self.hop
            self._select_hop()
            retain_from = max(0, self.next_start - self.semantic_left)
            self.buffer = self.buffer[retain_from - self.buffer_start:].copy()
            self.buffer_start = retain_from
        return results


class StreamingChatterbox(PcmStream):
    """Original PyTorch S3Gen execution of the bounded stream."""
    def __init__(self, s3gen, ref_dict, watermarker, config=StreamConfig()):
        import torch
        self.torch = torch
        self.model, self.ref_dict, self.watermarker = s3gen, ref_dict, watermarker
        self.device = s3gen.device
        if self.device.type not in ("mps", "cuda"):
            raise ValueError("This profile requires an explicit MPS or CUDA device")
        super().__init__(config)

    def synchronize(self):
        if self.device.type == "mps":
            self.torch.mps.synchronize()
        else:
            self.torch.cuda.synchronize(self.device)

    def reset(self):
        super().reset()
        self.random = self.torch.Generator(device="cpu").manual_seed(self.config.seed)
        self.prompt_noise = self._noise(self.ref_dict["prompt_feat"].shape[1])
        self.source_noise = self._noise(self.maximum_window_tokens * 2)

    def _noise(self, frames):
        return self.torch.randn(1, 80, frames, generator=self.random).to(self.device)

    def _render(self, source):
        torch, np = self.torch, self.np
        stages = {}
        started = time.perf_counter()
        enabled = self.config.precision == "fp16"
        with torch.inference_mode(), torch.autocast(self.device.type, dtype=torch.float16, enabled=enabled):
            tensor = torch.from_numpy(source).to(self.device)[None]
            tokens, _ = self.model.tokenizer(tensor)
            tokens = tokens[:, -self.window_tokens:]
            if tokens.shape[1] != self.window_tokens:
                raise RuntimeError("Tokenizer returned an unexpected temporal shape")
            if self.committed_tokens is not None:
                tokens = torch.cat((self.committed_tokens, tokens[:, self.acoustic_left_tokens:]), dim=1)
            self.synchronize()
            stages["tokenizerMs"] = (time.perf_counter() - started) * 1000
            started = time.perf_counter()
            noise = torch.cat((self.prompt_noise, self.source_noise[:, :, :self.window_tokens * 2]), dim=2)
            mel = self.model(
                tokens, ref_wav=None, ref_sr=None, ref_dict=self.ref_dict,
                finalize=True, skip_vocoder=True,
                n_cfm_timesteps=self.config.steps, noised_mels=noise,
            )
            self.synchronize()
            stages["acousticMs"] = (time.perf_counter() - started) * 1000
            started = time.perf_counter()
            wav, _ = self.model.hift_inference(mel.to(dtype=self.model.dtype))
            wav = wav.squeeze().float().cpu().numpy()
            self.synchronize()
            stages["vocoderMs"] = (time.perf_counter() - started) * 1000
        started = time.perf_counter()
        # Keep upstream watermarking, with context on both sides of the emitted region.
        with torch.inference_mode():
            wav = self.watermarker.apply_watermark(wav, sample_rate=self.output_rate)
        stages["watermarkMs"] = (time.perf_counter() - started) * 1000
        self._advance_context(tokens)
        output, alignment = self._align(wav)
        return output, {**stages, **alignment}

    def _advance_context(self, tokens):
        end = self.acoustic_left_tokens + self.hop_tokens
        self.committed_tokens = None if tokens is None else tokens[:, end - self.acoustic_left_tokens:end].clone()
        self.source_noise = self.torch.cat((self.source_noise[:, :, self.hop_tokens * 2:], self._noise(self.hop_tokens * 2)), dim=2)


class MlxStreamingChatterbox(PcmStream):
    """Same learned S3Gen model on Metal, with fixed per-stream diffusion noise."""
    def __init__(self, backend, reference, watermarker, config=StreamConfig()):
        if config.precision != "fp32":
            raise ValueError("MLX streaming is qualified only for the original float32 weights")
        self.backend, self.ref_dict, self.watermarker = backend, reference, watermarker
        super().__init__(config)

    def synchronize(self):
        self.backend.mx.synchronize()

    def reset(self):
        super().reset()
        self.random = self.np.random.default_rng(self.config.seed)
        self.backend.mx.random.seed(self.config.seed)
        self.prompt_noise = self._noise(self.ref_dict["prompt_feat"].shape[1])
        self.source_noise = self._noise(self.maximum_window_tokens * 2)

    def _noise(self, frames):
        return self.random.standard_normal((1, 80, frames), dtype=self.np.float32)

    def _render(self, source):
        np, stages = self.np, {}
        started = time.perf_counter()
        tokens = self.backend.tokenize(source)[:, -self.window_tokens:]
        if tokens.shape[1] != self.window_tokens:
            raise RuntimeError("Tokenizer returned an unexpected temporal shape")
        if self.committed_tokens is not None:
            tokens = np.concatenate([self.committed_tokens, tokens[:, self.acoustic_left_tokens:]], axis=1)
        stages["tokenizerMs"] = (time.perf_counter() - started) * 1000
        started = time.perf_counter()
        noise = np.concatenate([self.prompt_noise, self.source_noise[:, :, :self.window_tokens * 2]], axis=2)
        mel = self.backend.mel(tokens, self.ref_dict, noise, self.config.steps)
        self.synchronize()
        stages["acousticMs"] = (time.perf_counter() - started) * 1000
        started = time.perf_counter()
        wave = self.backend.vocode(mel)
        stages["vocoderMs"] = (time.perf_counter() - started) * 1000
        started = time.perf_counter()
        import torch
        with torch.inference_mode():
            wave = self.watermarker.apply_watermark(wave, sample_rate=self.output_rate)
        stages["watermarkMs"] = (time.perf_counter() - started) * 1000
        self._advance_context(tokens)
        output, alignment = self._align(wave)
        return output, {**stages, **alignment}

    def _advance_context(self, tokens):
        end = self.acoustic_left_tokens + self.hop_tokens
        self.committed_tokens = None if tokens is None else tokens[:, end - self.acoustic_left_tokens:end].copy()
        self.source_noise = self.np.concatenate([self.source_noise[:, :, self.hop_tokens * 2:], self._noise(self.hop_tokens * 2)], axis=2)
