# SPDX-License-Identifier: MIT
"""Explicit MLX execution of the same S3Gen weights, with a compiled CFM step."""
import hashlib
import json
from pathlib import Path
import numpy as np


class MlxChatterbox:
    def __init__(self, directory, compile_step=True):
        import mlx.core as mx
        from mlx.utils import tree_flatten
        from safetensors.numpy import load_file
        from mlx_audio.tts.models.chatterbox.s3gen.s3gen import S3Token2Wav
        from mlx_audio.tts.models.chatterbox.s3tokenizer import S3TokenizerV2, log_mel_spectrogram
        if not mx.metal.is_available():
            raise RuntimeError('The MLX Chatterbox profile requires Metal')
        mx.set_default_device(mx.gpu)
        # Bound reusable Metal allocations; reference extraction otherwise leaves
        # nearly a gigabyte of idle buffers resident alongside the audio graph.
        mx.set_cache_limit(128 * 1024 * 1024)
        self.mx = mx
        self.log_mel = log_mel_spectrogram
        directory = Path(directory)
        manifest = json.loads(Path(__file__).with_name('model-lock.json').read_text())['model']
        for name, expected in manifest['files'].items():
            with (directory / name).open('rb') as handle:
                if hashlib.file_digest(handle, 'sha256').hexdigest() != expected:
                    raise RuntimeError(f'Chatterbox checkpoint mismatch: {name}')
        original = load_file(directory / 's3gen.safetensors')
        self.model = S3Token2Wav()
        self.tokenizer = S3TokenizerV2('speech_tokenizer_v2_25hz')
        constants = {
            'flow.decoder.rand_noise', 'flow.encoder.embed.pos_enc.pe',
            'flow.encoder.up_embed.pos_enc.pe', 'mel2wav.stft_window', 'trim_fade',
        }
        for model, weights, allowed in [
            (self.model, {k: mx.array(v) for k, v in original.items() if not k.startswith('tokenizer.')}, constants),
            (self.tokenizer, {k[10:]: mx.array(v) for k, v in original.items() if k.startswith('tokenizer.')}, set()),
        ]:
            converted = model.sanitize(weights)
            expected = dict(tree_flatten(model.parameters()))
            missing = set(expected) - set(converted)
            if missing != allowed or set(converted) - set(expected):
                raise RuntimeError(f'Incomplete MLX checkpoint mapping: missing={missing}, extra={set(converted)-set(expected)}')
            # Only known non-checkpoint buffers come from the implementation.
            # The upstream noise buffer is unused: mel() supplies seeded noise.
            converted.update({key: expected[key] for key in missing})
            model.load_weights(list(converted.items()), strict=True)
            model.eval()
        mx.eval(self.model.parameters(), self.tokenizer.parameters())
        self.step = mx.compile(self._step) if compile_step else self._step

    def tokenize(self, source):
        mx = self.mx
        mel = self.log_mel(mx.array(source)[None])
        tokens, _ = self.tokenizer.quantize(mel, mx.array([mel.shape[-1]]))
        mx.eval(tokens)
        return np.asarray(tokens)

    def conditioning(self, tokens, reference):
        mx, flow = self.mx, self.model.flow
        tokens = mx.array(tokens, dtype=mx.int32)
        prompt = mx.array(reference['prompt_token'], dtype=mx.int32)
        embedding = mx.array(reference['embedding'])
        embedding = embedding / mx.maximum(mx.linalg.norm(embedding, axis=1, keepdims=True), 1e-12)
        spks = flow.spk_embed_affine_layer(embedding)
        combined = mx.concatenate([prompt, tokens], axis=1)
        h, _ = flow.encoder(flow.input_embedding(combined), mx.array([combined.shape[1]]), streaming=False)
        mu = mx.transpose(flow.encoder_proj(h), (0, 2, 1))
        prompt_mel = mx.transpose(mx.array(reference['prompt_feat']), (0, 2, 1))
        cond = mx.concatenate([prompt_mel, mx.zeros((1, 80, mu.shape[-1] - prompt_mel.shape[-1]))], axis=2)
        mask = mx.ones((1, 1, mu.shape[-1]))
        return mu, mask, spks, cond

    def _step(self, x, mu, mask, spks, cond, t, dt):
        mx = self.mx
        # Identical two-branch classifier-free guidance and Euler update to PyTorch S3Gen.
        result = self.model.flow.decoder.estimator(
            mx.concatenate([x, x]), mx.concatenate([mask, mask]),
            mx.concatenate([mu, mx.zeros_like(mu)]), mx.concatenate([t, t]),
            mx.concatenate([spks, mx.zeros_like(spks)]),
            mx.concatenate([cond, mx.zeros_like(cond)]), streaming=False,
        )
        rate = self.model.flow.decoder.inference_cfg_rate
        return x + dt * ((1 + rate) * result[:1] - rate * result[1:])

    def mel(self, tokens, reference, noise, steps):
        mx = self.mx
        mu, mask, spks, cond = self.conditioning(tokens, reference)
        x = mx.array(noise)
        if x.shape != mu.shape:
            raise ValueError('Diffusion noise does not match the acoustic window')
        span = 1 - mx.cos(mx.linspace(0, 1, steps + 1) * (0.5 * np.pi))
        for i in range(steps):
            x = self.step(x, mu, mask, spks, cond, span[i:i+1], span[i+1] - span[i])
            # Queue dependent Metal work without blocking Python at every Euler
            # step. The final evaluation still completes the entire solve before
            # returning, including when the caller immediately measures timing.
            mx.async_eval(x)
        mx.eval(x)
        return x[:, :, reference['prompt_feat'].shape[1]:]

    def vocode(self, mel):
        mx, hift = self.mx, self.model.mel2wav
        f0 = hift.f0_predictor(mel)
        source, _, _ = hift.m_source(mx.swapaxes(hift._f0_upsample(f0[:, None]), 1, 2))
        wave = self.decode(mel, mx.swapaxes(source, 1, 2))
        self.mx.eval(wave)
        return np.asarray(wave).squeeze()

    def decode(self, mel, source):
        """Original Chatterbox HiFT forward graph, including the final 0.01 slope.

        MLX-Audio uses 0.1 for that final activation; the released PyTorch weights
        were trained with torch.nn.functional.leaky_relu's default of 0.01.
        All learned layers are loaded unchanged from the original checkpoint.
        """
        import mlx.nn as nn
        mx, hift = self.mx, self.model.mel2wav
        real, imag = hift._stft(source.squeeze(1))
        spectrum = mx.concatenate([real, imag], axis=1)
        x = mx.swapaxes(hift.conv_pre(mx.swapaxes(mel, 1, 2)), 1, 2)
        for i in range(hift.num_upsamples):
            x = nn.leaky_relu(x, negative_slope=hift.lrelu_slope)
            x = mx.swapaxes(hift.ups[i](mx.swapaxes(x, 1, 2)), 1, 2)
            if i == hift.num_upsamples - 1:
                x = mx.concatenate([x[:, :, 1:2], x], axis=2)
            excitation = mx.swapaxes(hift.source_downs[i](mx.swapaxes(spectrum, 1, 2)), 1, 2)
            x = x + hift.source_resblocks[i](excitation)
            outputs = [hift.resblocks[i * hift.num_kernels + j](x) for j in range(hift.num_kernels)]
            x = sum(outputs[1:], outputs[0]) / hift.num_kernels
        x = nn.leaky_relu(x, negative_slope=0.01)
        x = mx.swapaxes(hift.conv_post(mx.swapaxes(x, 1, 2)), 1, 2)
        bins = hift.istft_params['n_fft'] // 2 + 1
        return mx.clip(hift._istft(mx.exp(x[:, :bins]), mx.sin(x[:, bins:])), -hift.audio_limit, hift.audio_limit)

    def prepare_reference(self, source24, prompt_seconds):
        """Use the original signal features; execute all learned layers on MLX.

        Reference extraction happens once before readiness, outside the audio
        callback. Torch here supplies the original CPU STFT and Kaldi features.
        """
        import librosa
        import torch
        import torchaudio
        source24 = np.asarray(source24, dtype=np.float32)
        if source24.ndim != 1 or len(source24) < 24000 or not np.isfinite(source24).all():
            raise ValueError('Reference must contain at least one second of finite mono 24 kHz PCM')
        if not 1 <= prompt_seconds <= 10:
            raise ValueError('Acoustic prompt must be between 1 and 10 seconds')
        wave = torch.from_numpy(source24[:240000].copy())[None]
        with torch.inference_mode():
            source16 = torchaudio.transforms.Resample(24000, 16000)(wave)
            features = torchaudio.compliance.kaldi.fbank(source16, num_mel_bins=80, sample_frequency=16000, dither=0)
            features = features - features.mean(dim=0, keepdim=True)
            padded = torch.nn.functional.pad(wave[:, None], (720, 720), mode='reflect')[:, 0]
            spectrum = torch.stft(padded, 1920, hop_length=480, win_length=1920,
                                  window=torch.hann_window(1920), center=False, return_complex=True)
            magnitude = torch.sqrt(torch.view_as_real(spectrum).square().sum(-1) + 1e-9)
            filters = torch.from_numpy(librosa.filters.mel(sr=24000, n_fft=1920, n_mels=80, fmin=0, fmax=8000))
            mel = torch.log(torch.clamp(filters @ magnitude, min=1e-5)).transpose(1, 2).numpy()
        tokens = self.tokenize(source16.numpy()[0])
        embedding = self.speaker_embedding(self.mx.array(features.numpy()[None]))
        self.mx.eval(embedding)
        n = min(tokens.shape[1], mel.shape[1] // 2, round(prompt_seconds * 25))
        return {'prompt_token': tokens[:, :n], 'prompt_token_len': np.array([n], dtype=np.int32),
                'prompt_feat': mel[:, :n * 2], 'embedding': np.asarray(embedding)}

    def speaker_embedding(self, features):
        """CAMPPlus with the checkpoint's unbiased temporal standard deviation."""
        mx, speaker = self.mx, self.model.speaker_encoder
        x = speaker.tdnn(speaker.head(mx.swapaxes(features, 1, 2)))
        for block, transition in zip(speaker.blocks, speaker.transits, strict=True):
            x = transition(self._speaker_block(block, x))
        x = mx.swapaxes(x, 1, 2)
        for layer in speaker.out_nonlinear:
            x = layer(x)
        x = mx.swapaxes(x, 1, 2)
        if x.shape[-1] <= 1:
            raise ValueError('Reference is too short for speaker statistics')
        # torch.std defaults to correction=1, with no additive epsilon.
        mean = mx.mean(x, axis=-1)
        variance = mx.sum((x - mean[:, :, None]) ** 2, axis=-1) / (x.shape[-1] - 1)
        return speaker.dense(mx.concatenate([mean, mx.sqrt(variance)], axis=-1))

    def _speaker_block(self, block, x):
        """CAMP attention with ceil-mode pooling over actual, unpadded samples."""
        import mlx.nn as nn
        mx = self.mx
        for layer in block.layers:
            y = mx.swapaxes(x, 1, 2)
            for operation in layer.nonlinear1:
                y = operation(y)
            y = layer.linear1(y)
            for operation in layer.nonlinear2:
                y = operation(y)
            cam = layer.cam_layer
            local = cam.linear_local(y)
            # PyTorch avg_pool1d(ceil_mode=True) divides its last segment by
            # its real length. MLX-Audio pads it to 100 and includes those zeros.
            pooled = mx.concatenate([
                mx.broadcast_to(mx.mean(y[:, start:start + 100], axis=1, keepdims=True), y[:, start:start + 100].shape)
                for start in range(0, y.shape[1], 100)
            ], axis=1)
            context = mx.mean(y, axis=1, keepdims=True) + pooled
            mask = mx.sigmoid(cam.linear2(nn.relu(cam.linear1(context))))
            x = mx.concatenate([x, mx.swapaxes(local * mask, 1, 2)], axis=1)
        return x
