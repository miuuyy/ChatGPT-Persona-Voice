# Voice models

The v0.1.6 preview release includes two built-in audio-to-audio models. Chatterbox runs on Apple
Silicon while Seed-VC remains available on existing installations.
Both consume incoming speech continuously and preserve the selected source and target voice.
Changing the interface language does not change the conversion model.

| Model | Upstream release | Best fit in this app | Available hardware |
| --- | --- | --- | --- |
| Seed-VC Tiny | [2024](https://github.com/Plachtaa/seed-vc#changelogs) | Japanese and Chinese; retains the existing realtime profile | Apple Silicon MPS; Windows/Linux x64 NVIDIA CUDA |
| Chatterbox | [2025](https://github.com/resemble-ai/chatterbox#citation) | Recommended for English and trying other languages; English live listening accepted | Apple Silicon MLX |

The Chatterbox adapter uses the original S3Gen voice-conversion checkpoint pinned in
`engine/chatterbox/model-lock.json`. It does not install Chatterbox Multilingual, Turbo, or V3.
The upstream TTS models' language lists are not a validation claim for this streaming converter.
Other languages and reference voices need their own listening checks.

## Setup and model management

On a fresh Apple Silicon installation, Chatterbox is preselected and marked Recommended. The user
can choose either card. Only that model is downloaded; completing first-run setup requires the
selected model to be installed and pass its readiness probe. Cancellation, network errors, or a
missing checkpoint keep setup open. Installing both models is never required.

Existing installations retain their selected model. State written before model selection existed
continues to use Seed-VC. Windows/Linux offer Seed-VC; the Chatterbox card explains its Apple
Silicon requirement and cannot be selected there.

After setup, open **Settings → Voice model**. Stop the relay, select the other model, and use its
**Download** button. Each card shows whether its package is installed. The selected package's
progress, retry/resume, cancellation, and removal controls are immediately below the cards.
Removing a model leaves the other model, voice references, source selection, and history intact.
There is no automatic model substitution after installation or conversion failure.

## Performance comparison

Measured on September 6, 2026 on Apple M4 Pro with 24 GB unified memory. Both models received the
same saved 61.259-second English source, the same private five-second target reference, and an
additional 1.2-second silence tail, paced as live input. The real model workers fed the native
Core Audio queue; hardware playback received silence while the converted PCM was saved locally.

| Measurement | Seed-VC Tiny | Chatterbox |
| --- | ---: | ---: |
| Source processing block | 300 ms | 640 ms |
| Sum of conversion-call wall time | 44.85 s | 31.67 s |
| First native queue start after paced input began | 2.66 s | 1.54 s |
| Native playback rebufferings | 0 | 0 |
| Model preparation before input pacing | 8.37 s | 5.98 s |
| Native prebuffer / clock reserve | 500 / 0 ms | 400 / 200 ms |

Chatterbox used **29.4% less conversion-call time** in this comparison. This measures processing
throughput, not a 29% reduction in CPU utilization, RAM, or end-to-end latency. Tiny uses smaller
blocks; that alone does not determine when a device starts playback. Earlier Tiny measurements
started playback sooner than this run, so these queue timings are specific observations rather
than a universal ranking. The two measured runs were executed sequentially.

Tiny's existing three-second startup discard was consumed before the timed speech in this
benchmark and is included in preparation work, not in the queue-start figure. In the app, that
discard applies once after each prepare/reset. Chatterbox has no startup discard and does not
wait for the end of a phrase. Its 640 ms chunks and 240 ms lookahead yield continuous output.
Source capture, route engagement, and speaker/DAC delay are outside these measurements.

The accepted Chatterbox profile separately measured about 2.8 GB peak process footprint on a
12-second source. This is not a comparative Seed-VC memory measurement. Installation estimates
are 4 GiB with 8 GiB free for Chatterbox; Seed-VC estimates 2.5 GiB / 6 GiB free on macOS,
9 GiB / 15 GiB free on Windows, and 11 GiB / 15 GiB free on Linux.

The owner's live English test with the alternate local reference was accepted after the bounded
640 ms profile and asynchronous MLX evaluation changes. That acceptance applies to this specific
voice, source, and host. Private reference files and captured audio are neither bundled nor
redistributed. Investigation methods and earlier failed profiles remain in
[Voice quality](VOICE_QUALITY.md).

Local evidence: `artifacts/multilingual-quality/live-noise/continuous-1/integration-seed-take2/report.json`
and `integration-chatterbox-take2/report.json` in the same directory. These ignored artifacts include
private paths/audio hashes and are intentionally absent from a source checkout or package. To
repeat with authorized audio, use `scripts/smoke-chatterbox-pipeline.cjs` and the explicit model,
reference, input, and native buffer arguments described in [Development](DEVELOPMENT.md).
