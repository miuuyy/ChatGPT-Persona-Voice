# Voice quality investigation

The offline tools in this document compare actual audio from the installed converter. They do
not certify native capture/playback latency, speaker similarity, or a release. Keep test audio,
private references, experimental checkpoints, and generated speech in the ignored `artifacts/`
directory. Neither script changes the selected voice or the installed app's model profile.

## Findings from the September 6, 2026 investigation

The production converter is audio-to-audio: changing the UI locale cannot fix its pronunciation
or timbre. The initial profile used Seed-VC Tiny, XLS-R features, a HiFT vocoder, 300 ms blocks,
10 diffusion steps, and a 3-second acoustic prompt.

One definite implementation defect was reproduced and fixed: the worker treated every block
below RMS 0.0015 (about -56.5 dBFS) as silence. Real quiet English speech fell below that threshold.
The worker now processes all nonzero input and skips digital silence after draining its existing
overlap. It does not perform speech recognition or noise suppression to decide which blocks to
keep. Continuous background noise can therefore keep inference active. RMS accumulation uses
float64 to preserve the distinction between small valid float32 samples and zeros.

The same four English recordings, reference, locked Tiny weights, seed, and streaming settings
were compared before and after the change. Source-ASR character error on the two quiet recordings
fell from 92.3% to 0.6%, and from 32.6% to 0.0%. These are text-retention measurements relative to
the source's own local transcription, not naturalness scores. The papery/rustling sound on Tiny remained; the accepted Chatterbox follow-up is described below.

The following experiments did not establish a general timbre fix:

- Increasing future context from 20 ms to 180/320 ms did not produce a consistent multilingual
  intelligibility gain; the listener reported no difference in the first comparison.
- Replacing Tiny's HiFT with a mel-compatible BigVGAN did not establish a quality improvement
  and exceeded the 300 ms processing budget on the tested Mac.
- Whole-utterance Seed-VC Small with Whisper, its full-band BigVGAN, 25 diffusion steps, and a
  9-second prompt was preferred by the listener on an English comparison. Rustling remained.
  Its 8.76-second sample took about 6.66 seconds to convert after receiving the whole utterance.
  Small's 300 ms streaming profile took about 730–750 ms per block at only 10 steps. Neither
  measurement qualifies it as a replacement for the current realtime profile.
- Switching only the BigVGAN vocoder to float32 produced a waveform correlation of 0.9988 with
  the half-precision result. Switching only diffusion to float32 on a clean synthetic English
  sample likewise produced a correlation of 0.9987. Neither establishes removal of the artifact.
- A private reference's raw, processed, alternate-recording, and gain-adjusted versions were
  compared with equal playback loudness. Text recognition remained intact on the clean source;
  reference selection still requires listening rather than an automatic score.

The worker also converts vocoder output to float32 before SOLA. This preserves the float32 audio
contract when an experimental vocoder returns half precision; it is not the multilingual quality
fix. The production model lock, selected voice, acoustic prompt length, and latency profile are
unchanged by these tools.

Alternative-model results must be qualified by their input and implementation. For example, the
tested audio.cpp MeanVC2 CPU port damaged words on one real English recording, including with
leading silence, but retained the words in three clean synthesized English recordings from the
same Kokoro voice. That is insufficient to reject or accept its English support. It is not an official Python/CUDA parity
test, and it is not an installed Persona Voice adapter.

On that 4.95-second synthetic source, an instrumented MeanVC2 run on four CPU threads measured
10.7 ms median and 17.7 ms p95 per 160 ms input chunk; the slowest call was 300 ms. Total chunk
computation plus finalization had RTF 0.137. These measurements exclude reference preparation,
native routing, and real-time input pacing. Instrumentation preserved the output samples exactly.
Official ChatterboxVC was also run on MPS with verified local weights and its upstream PerTh
watermark. Its first single test took 7.88 seconds for 4.96 seconds of output. A subsequent latency
comparison corrected the initial throughput assessment: the same output took 2.45 seconds on the
first call, then 1.75–1.77 seconds on three repeated calls. The samples matched the audition's D
output exactly. A single initial call must not be treated as steady-state throughput.

For the identical 4.95-second source, three warmed Tiny streaming runs averaged 203–211 ms per
300 ms block (per-run p95 212–241 ms). D's warmed whole-utterance RTF was 0.357, so its tested
whole-utterance computation is faster than realtime. However, `ChatterboxVC.generate()` consumes
the complete source and returns the complete output. With source audio arriving live, that path
would first need 4.95 seconds of input and then about 1.77 seconds of computation: approximately
6.72 seconds until its first returned audio, excluding native output and session preparation.
This is a calculation from the tested execution order, not a live-route measurement. Throughput
on a full utterance does not establish throughput or quality on small streaming chunks.

The existing Tiny app additionally has a 500 ms output prebuffer target and discards the first
3 seconds of captured input once per session. The prebuffer is a quantity of queued audio, not
an independent 500 ms compute call; startup discard is not a recurring delay on every sentence.
Neither these settings nor offline model timing establish end-to-end p95 latency. The bounded
Chatterbox implementation below now provides a real stream; listening acceptance and installation
in the released application remain separate from that implementation.

## Bounded Chatterbox implementation

`engine/chatterbox/streaming.py` accepts at most 40 ms of mono PCM per call and emits audio while
the input is still arriving. It uses fixed left context, declared lookahead, time-aligned diffusion
noise, and overlap alignment. It never detects a sentence end or waits for an utterance. Only an
explicit stream finish pads the final window; interruption resets and discards pending audio.
Digital silence preserves the sample clock, fades existing overlap, and clears speech context.
Every nonzero input, including very quiet speech, reaches the model.

Two executors are available for comparison: original PyTorch S3Gen and Apple Silicon MLX. The
MLX executor loads every learned tensor from the original checkpoint with strict key validation.
It implements three corrections to the tested MLX-Audio revision: the vocoder's final LeakyReLU
uses 0.01, CAMPPlus averages partial segments by their actual length, and its temporal standard
deviation uses the original sample correction. Numeric golden tests cover tokenizer IDs, mel
output, F0, and waveform decoding with identical excitation. Two original-model windows matched
all token IDs; relative mel error was about 4e-7 and waveform error about 4e-6–6e-6. Separate
reference extraction matched the original speaker embedding to relative error 1.5e-6.

The current locked profile uses float32 weights, 10 diffusion steps, 640 ms blocks, 240 ms
lookahead, a 3-second acoustic prompt, and up to 10 seconds for speaker embedding. It retains the
original PerTh watermark. The Metal allocation cache is bounded to 128 MiB, and CPU Torch work
uses one thread. No model download, CPU neural fallback, or automatic quality downgrade happens
inside the worker.

An earlier 400 ms profile's 85.425-second paced converter run averaged 326 ms per block, with p95 385 ms and source-to-output
availability p95 1.03 s. This was followed by a separate run that exceeded its realtime budget;
the latter is retained in the investigation artifacts. Thus the successful run is not a guarantee
under arbitrary machine load. Shorter prompt/context and small-initial-block experiments reduced
latency but worsened words on the real male English recording, so they were not selected for the
locked profile. The experimental stream configuration still allows reproducing those comparisons.

`engine/chatterbox/worker.py` supplies a real CPVE process with continuous source resampling;
`electron/chatterbox-engine.cjs` supplies bounded 20 ms output frames to the existing pipeline
interface. Both validate finite PCM, shapes, hashes and lifecycle. Reset invalidates in-flight
results, corruption terminates the process, and concurrent close calls share one shutdown.
The first worker/native smoke produced complete audio and zero playback rebufferings. With the
existing 500 ms Core Audio prebuffer, its first queue start was 1.49 s after source began. This
includes live input pacing and the real worker, but excludes OS source capture and hardware/DAC
latency. The Core Audio adapter can now request a specific bounded prebuffer and verifies that
the helper actually accepted it; existing callers retain 500 ms. Reducing that target to 400 ms
started playback in 1.04 s but produced two rebufferings in the 85-second native run. The final
native run used a 400 ms prebuffer plus a bounded 200 ms clock reserve: first model output in
1.01 s, Core Audio queue startup in 1.25 s, and zero rebufferings over 85.425 seconds of source.
The clock reserve continues reading input and starts early if the bounded pool fills; it does
not wait for a future model block or sentence endpoint. These timings are measured on this Mac,
with a local source fixture; they do not establish hardware-loopback or cross-platform latency.

The launcher now offers Seed-VC Tiny and Chatterbox in first-run setup and Settings → Voice model. Stop the
relay before switching; the same source and voice stay selected. Chatterbox has a separate
installer on Apple Silicon and uses the measured 400/200 ms native output profile. This is a
built-in adapter, not a published SDK or a claimed cross-platform release.

Live listening subsequently exposed an unresolved noise defect in D. A consented local capture
contained 61.26 seconds of source PCM and 60.40 seconds of converted output, with no native
rebuffering. Replaying that source through the worker reproduced the recorded output to relative
waveform error 3.4e-7. Instrumentation found noise before watermarking and overlap alignment;
original PyTorch S3Gen reproduced the observed mel tensors to relative error below 4.8e-7.
In the final two seconds, nearly inaudible source residue produced a noise tail roughly 25 dB
louder than the original model's whole-fragment control. This narrows that measured defect to
short-context reconstruction; it does not yet identify every sound reported during speech.
Changing packet sizes, stitching, feature-floor normalization, or caching acoustic history did
not establish a fix. Whole-fragment inference is a diagnostic control, not a realtime replacement.
The listener preferred the whole-fragment control and rejected the original live output.
Feature-floor and acoustic-cache experiments were not adopted. A later change queues the same
Euler steps asynchronously and waits for their completion once, instead of blocking Python after
every step. Six interleaved checks matched the previous mel output exactly and reduced mean CFM
time from 298 to 278 ms without increasing peak active memory. A 400 ms native retest still
rebuffered twice over the captured minute, so the locked output block is now 640 ms. With an
alternate private five-second Scarlett reference, the 61.26-second source plus a 1.2-second tail
passed the native queue with zero rebufferings and first playback at 1.54 seconds. This is a
specific-host measurement; the earlier failures remain recorded. The reference is available
locally as a separate voice. The owner subsequently accepted its live English sound on this Mac.
A later same-source comparison measured 29.4% less conversion-call time than Tiny; see
[Voice models](VOICE_MODELS.md) for the full conditions and timing boundaries.
Raw paired PCM, private references, and diagnostic listening copies stay in ignored local
artifacts. This specific live acceptance does not establish equal quality for every language or reference.

For application use, run `bun run setup:chatterbox` or select Chatterbox in Settings → Voice model and
install it there. This creates `runtime/chatterbox` in a source checkout; the app never resolves
experimental environments under `artifacts/`. The commands below describe independent benchmarks.

Install the separate measured environment on macOS arm64 (CPython 3.11.14):

```bash
uv venv --python 3.11.14 artifacts/chatterbox-runtime
uv pip sync --python artifacts/chatterbox-runtime/bin/python \
  engine/chatterbox/requirements-macos-arm64.lock.txt
```

Obtain `s3gen.safetensors` from the repository/revision in `engine/chatterbox/model-lock.json`
and preserve its SHA-256. The benchmark also expects the checkpoint provenance `manifest.json`
described below; the worker independently verifies against the checked-in lock.

```bash
"$CHATTERBOX_PYTHON" scripts/benchmark-chatterbox-streaming.py \
  --backend mlx --sources artifacts/quality/sources.json --reference "$REFERENCE_WAV" \
  --weights "$CHATTERBOX_WEIGHTS" --block-ms 640 --lookahead-ms 240 --prompt-seconds 3 \
  --steps 10 --paced --output artifacts/quality/chatterbox-stream

node scripts/smoke-chatterbox-pipeline.cjs \
  --engine chatterbox --source "$SOURCE_WAV" --reference "$REFERENCE_WAV" \
  --python "$CHATTERBOX_PYTHON" --weights "$CHATTERBOX_WEIGHTS" \
  --prebuffer-ms 400 --startup-delay-ms 200 --output artifacts/quality/chatterbox-native
```

The native smoke saves converted audio while playing digital silence with identical packet sizes
and timings; add `--play` to hear the conversion. Use `--engine seed --prebuffer-ms 500` for the
old adapter on the same file. Its documented startup discard is exercised before the steady-state
measurement and reported separately. Source hashes, padding, queue startup and underruns are
recorded, so a model-only timing cannot be confused with a native queue timing.

Numeric regression checks use separately exported original-model fixtures:

```bash
"$ORIGINAL_CHATTERBOX_PYTHON" scripts/validate-chatterbox-mlx.py export \
  --source "$SOURCE_WAV" --reference "$REFERENCE_WAV" --weights "$CHATTERBOX_WEIGHTS" \
  --fixtures artifacts/quality/original-goldens
"$CHATTERBOX_PYTHON" scripts/validate-chatterbox-mlx.py check \
  --weights "$CHATTERBOX_WEIGHTS" --fixtures artifacts/quality/original-goldens \
  --output artifacts/quality/parity.json
"$CHATTERBOX_PYTHON" tests/chatterbox-streaming.test.py
"$CHATTERBOX_PYTHON" tests/chatterbox-worker.test.py
node --test tests/chatterbox-engine.test.cjs tests/macos-audio-output.test.cjs
```

## Generate controlled comparisons

First install the exact runtime using the normal [development setup](DEVELOPMENT.md). Run the
benchmark with that runtime's interpreter, not an unrelated Python environment:

```bash
runtime/seed-vc/.venv/bin/python scripts/benchmark-seed-vc-quality.py --help
```

Create a UTF-8 manifest next to local source WAVs. Paths are relative to the manifest. Source IDs
must be unique lowercase filename components. SHA-256 values are verified before inference.
Use actual hashes; the following is a schema example:

```json
{
  "sources": [
    {
      "id": "en-sentence-1",
      "language": "en",
      "path": "en-sentence-1.wav",
      "sha256": "<SHA-256 of the WAV bytes>",
      "transcript": "The complete spoken sentence.",
      "source": "Recording provenance and redistribution terms"
    }
  ]
}
```

Each recording must contain 0.06–30 seconds of finite audio. Include real and synthetic sources,
quiet and normal levels, and multiple speakers. Record which transcripts are human ground truth
and which were generated by ASR. A voice-quality claim should not rest on one sentence.

```bash
runtime/seed-vc/.venv/bin/python scripts/benchmark-seed-vc-quality.py \
  --sources artifacts/quality/sources.json \
  --reference "$REFERENCE_WAV" \
  --profiles current whole-utterance \
  --output artifacts/quality/comparison-1
```

Output directories must be new. The tool preserves generated float WAVs and writes `report.json`
with hashes, settings, source/output duration, inferred-block timings, and device memory. The
streaming profiles use the real worker with one second of leading and trailing silence. These
margins remain in the output so that start/tail defects are not hidden. Timings exclude skipped
silent blocks but include the worker's resampling and synchronization. Whole-utterance timing
starts only after the entire source is available.

Use `--worker-file` to compare an explicit saved revision of the worker. The report records its
path and hash. For example, save `git show <revision>:engine/seed-vc/worker.py` into an ignored
file and run it with the same sources, reference, parameters, and runtime. This does not change
the app's worker. Do not compare different models and attribute the result solely to a code fix.

Experiments are explicit:

- `--profiles` selects current, alternate context/block sizes, a longer prompt, whole-utterance
  inference, or `vocoder-reconstruction`. Reconstruction feeds the source's real mel spectrogram
  into the vocoder; its output retains the source speaker and is not voice conversion.
- `--steps` and `--prompt-seconds` vary diffusion and acoustic conditioning.
- `--vocoder-precision` and `--diffusion-precision` independently select fp16/fp32 computation.
- `--vocoder-dir` requires local BigVGAN weights, config, and a SHA-256 manifest. Its sample rate,
  FFT, hop/window, mel bands, and frequency limits must match the acoustic model. Null `fmax`
  means Nyquist; an 8 kHz model and a full-band model are not interchangeable.
- `--acoustic-model-dir` requires a verified local Seed-VC Small/Whisper checkpoint directory
  and its matching full-band vocoder. It is an offline research option, not a product profile.
- `--device` explicitly selects MPS or CUDA. The production runtime verification still applies.

Experimental checkpoint directories use `manifest.json` with a `files` object mapping relative
filenames to SHA-256 values. Preserve repository revisions and licenses with the checkpoints.
The Small experiment expects the upstream
`DiT_seed_v2_uvit_whisper_small_wavenet_bigvgan_pruned.pth`,
`config_dit_mel_seed_uvit_whisper_small_wavenet.yml`, and a local `whisper/` model directory.
BigVGAN expects `config.json` and `bigvgan_generator.pt`. The tools do not download these assets.

## Score and listen

Keep evaluation dependencies separate from the locked product runtime. `score-voice-quality.py`
uses local MLX Whisper, librosa, soundfile, and NumPy; optional DNSMOS additionally uses ONNX
Runtime. It requires already downloaded model paths and does not upload speech.

```bash
"$EVALUATION_PYTHON" scripts/score-voice-quality.py \
  --sources artifacts/quality/sources.json \
  --reports artifacts/quality/comparison-1/report.json \
  --whisper-model "$LOCAL_MLX_WHISPER_MODEL" \
  --dnsmos-model "$LOCAL_DNSMOS_MODEL" \
  --output artifacts/quality/scores-1.json
```

The output contains each actual transcription, reference CER/WER, and source-ASR CER/WER.
Comparing with the source's own transcription helps expose changes introduced by conversion,
while still carrying the recognizer's errors. Japanese and Chinese use character error only.
The optional Microsoft DNSMOS P.835 score measures a signal-quality proxy. It does not measure
target-speaker likeness or establish that synthesized speech sounds natural. In this investigation
the listener preferred a variant with a lower DNSMOS score.

For listening, keep the same source, target reference, and sentence across variants. Include the
unconverted source. Match playback loudness with constant gain and encode listening copies as
PCM WAV; retain the original outputs and gain values. Do not silently add denoising, dynamics,
or EQ to the comparison. A proposed default needs audible acceptance and the complete
[release gates](RELEASE.md), including sustained native-route timing.

Primary implementation references:

- [Seed-VC](https://github.com/Plachtaa/seed-vc), pinned product source and model revisions in
  `engine/seed-vc/model-lock.json`.
- [FLEURS](https://huggingface.co/datasets/google/fleurs), real multilingual source recordings.
- [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), the official clean English demo used as a
  synthetic source control.
- [Microsoft DNSMOS](https://github.com/microsoft/DNS-Challenge/tree/master/DNSMOS), the optional
  signal-quality estimator.
