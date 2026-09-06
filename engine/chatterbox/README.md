# Chatterbox streaming adapter

The built-in Apple Silicon model consumes audio through CPVE and emits 24 kHz mono float32
in 20 ms frames. The locked profile uses 640 ms blocks, 240 ms lookahead, ten diffusion steps,
a three-second acoustic prompt, and FP32 MLX execution. It never waits for a sentence endpoint.

`model-lock.json` and `requirements-macos-arm64.lock.txt` pin the original Resemble AI S3Gen
checkpoint, learned tensor mapping, CPython 3.11.14, packages, and Git revisions. `install.py`
verifies the runtime, Metal, SHA-256 and model graph before publishing an installation receipt.
The pinned Hugging Face client resumes downloads in owned staging without account tokens.

Install using first-run setup, Settings → Voice model, or `bun run setup:chatterbox` in a source
checkout. `--checkpoint /absolute/path/s3gen.safetensors` explicitly imports the same verified
checkpoint for developer/offline setup. It is never used as an automatic network fallback.

Only this engine's runtime is removed by its installer. Private references, captured source audio,
benchmarks, Python environments and model weights are excluded from the application assets.
See [model comparison](../../docs/VOICE_MODELS.md), [contract](../../docs/ENGINE_CONTRACT.md) and
[third-party notices](../../THIRD_PARTY_NOTICES.md) for evidence, lifecycle and licensing.
