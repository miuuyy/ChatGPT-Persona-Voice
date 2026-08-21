# Contributing

Thanks for helping improve Codex Persona Voice. This is an experimental, fail-closed audio project,
so a useful contribution includes truthful capability boundaries and recovery behavior, not only a
working happy path.

## Before you start

- Read [Development](docs/DEVELOPMENT.md), [Architecture](docs/ARCHITECTURE.md), and the
  [Platform matrix](docs/PLATFORM_MATRIX.md).
- Search existing issues and pull requests.
- For a substantial new backend, protocol change, platform route, engine, installer, or persistence
  schema, open a focused design issue before writing a large patch.
- Report suspected vulnerabilities privately according to [SECURITY.md](SECURITY.md).
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

The source relay is implemented and live-accepted for Apple Silicon macOS 14.2+ and NVIDIA Linux
x64. Windows x64 has a packaged VB-CABLE path but limited clean physical-host E2E evidence. Linux
live evidence covers Ubuntu 24.04/WirePlumber 0.4 and Fedora 42/PipeWire 1.4.11/WirePlumber 0.5.14.
Windows development must continue to report the separately installed VB-CABLE version and the
explicit Volume Mixer assignment/restoration lifecycle until that path is broadly qualified.
Linux clean packaged recovery and broader distribution coverage also remain. Do not turn
implemented source into a support claim.

## Repository layout

The source tree keeps product media, voice references, and the conversion engine separate:

| Path | What belongs here |
| --- | --- |
| `assets/` | Repository-facing icon, architecture banner, and README demo |
| `src/assets/` | Media imported by the renderer, including authorized character scenes |
| `voices/manifest.json` | Target-voice identity, credit, terms URL, file path, and SHA-256 |
| `voices/references/` | Short, clean WAV references used to condition conversion |
| `engine/seed-vc/` | The CPVE adapter, immutable model lock, verification, and installer inputs |
| `engine/vendor/seed-vc/` | Pinned upstream Seed-VC source; never edit it as ordinary launcher code |
| `native/macos/` | Core Audio capture/output and atomic update helper |
| `native/linux/` | PipeWire capture/output and WirePlumber 0.4/0.5 policy assets |
| `native/windows/` | WASAPI process-loopback, route verifier, and bounded output helpers |
| `scripts/` | Reproducible setup, build, packaging, and smoke commands |

Reference WAVs are not trained voice models. Model weights, Python environments, caches, build
products, logs, history, and smoke output are downloaded or generated into ignored paths and must
not be committed.

## Development workflow

```bash
git submodule update --init --recursive
bun install --frozen-lockfile
bun run check
```

Data-path contributors on a qualified host should also run the applicable commands:

```bash
bun run setup:engine
bun run build:native
bun run test:native
bun run smoke:engine
```

Linux route work must also inspect/install the managed policy in a dedicated user session and
record the exact WirePlumber family:

```bash
node scripts/linux-audio-policy.cjs inspect
node scripts/linux-audio-policy.cjs install --reload
```

Windows route work must state the VB-CABLE version, whether Windows was restarted after installation,
and the exact Volume Mixer assignment. A renamed or substitute endpoint is not equivalent to the
base official VB-CABLE Input. Record every explicit assignment, verification, and restoration.

Live capture and jitter smokes are opt-in because they affect local permissions/audio devices:

```bash
bun run smoke:capture:mac
bun run smoke:output:jitter:mac
```

Never include generated model/runtime directories, virtual environments, native build outputs,
smoke audio, user history, or logs in a pull request.

## Scope and architecture rules

- No compatibility shims, hidden fallback engines, unconverted pass-through, or fake readiness.
- Preserve source → suppression → engine → output transaction ordering.
- A processing fault must not release or bypass route ownership out of order.
- Bound PCM queues by bytes/duration, child-protocol messages by length, and every blocking lifecycle
  operation by a documented timeout.
- Renderer values cannot become arbitrary executable, model, voice, or history paths.
- Capability reports must distinguish implemented, possible, blocked, and unsupported.
- Do not make latency, privacy, signing, packaging, or platform support claims without reproducible
  evidence.

## Tests and documentation

Add a regression test for any behavior change. Protocol, lifecycle, queue, timeout, format, storage,
or capability changes must update their contract documents in the same PR.

Minimum PR verification is:

```bash
bun run test
bun run typecheck
bun run build:renderer
```

Report exact commands and outcomes. “Tests pass” without scope/host information is insufficient for
native, permissioned, engine, or performance changes.

CI runs these non-permissioned checks plus target-native build/self-tests on macOS, Windows, and
Linux. A green job proves those build/protocol contracts. It does not prove a live desktop route,
CUDA performance, Windows VB-CABLE recovery, Linux policy recovery, or supported release status.

## Adding a target voice

Voice contributions are welcome only when another maintainer can independently verify where the
reference came from and that this repository may redistribute it. Open source software, a public
URL, or the ability to download audio does **not** by itself grant copyright, performer,
personality, publicity, character, or trademark rights.

Before adding audio:

1. Identify the speaker or fictional voice accurately and obtain the necessary permission or an
   upstream license that explicitly covers redistribution of the reference audio. Never submit
   private, leaked, scraped, secretly recorded, or provenance-unknown speech.
2. Record the immutable upstream URL/revision, applicable terms, required credit, and any consent or
   authorization evidence that can be reviewed without exposing private data.
3. For a real public figure, actor-like voice, or protected fictional identity, request maintainer
   review before committing the file. It must be clearly labeled as an AI likeness, must not imply
   endorsement, and must not be intended for deception. A code or model license alone is not enough.
4. Prepare a clean, single-speaker reference without music, sound effects, other speakers, clipping,
   or avoidable room noise. Prefer 8–20 seconds of varied natural speech. Encode it as mono PCM16 WAV
   at 22.05 kHz and keep it below the catalog's 16 MiB hard limit.
5. Save it as `voices/references/<voice-id>.wav`, then add one entry to
   `voices/manifest.json`. Use a stable lowercase-hyphen ID and record the exact SHA-256, locale,
   required credit, and HTTPS terms URL.
6. Add the provenance, transformation, redistribution basis, disclosure, and exact digest to the
   matching section of `THIRD_PARTY_NOTICES.md`. This is the single human-readable notice inventory;
   do not create a second per-voice notice file.
7. Extend `tests/voice-catalog.test.cjs` and run the verification below. A successful local preview
   does not replace the rights and provenance review.

Suggested deterministic conversion:

```bash
ffmpeg -i source.wav -ar 22050 -ac 1 -c:a pcm_s16le voices/references/<voice-id>.wav
shasum -a 256 voices/references/<voice-id>.wav
node --test tests/voice-catalog.test.cjs
bun run check
```

Character artwork is a separate contribution with separate rights; follow
[Character scene contributions](#character-scene-contributions) even when the voice reference is
approved.

## Other third-party code and models

Original launcher code is MIT-licensed. The Seed-VC worker uses GPL-3.0 source, and model/voice
materials retain their own licenses and terms. A contribution that changes bundled or downloaded
third-party material must include:

- upstream project and immutable revision;
- expected hashes for fetched artifacts;
- license and redistribution analysis;
- corresponding-source/notice delivery where required;
- network, disk, update, and removal behavior;
- authorization, terms URL, required credit, and any identity-specific disclosure.

## Character scene contributions

Use the repository skill `$persona-character-scenes` when adding or replacing a voice-session
character background. It is checked in at
`.agents/skills/persona-character-scenes/SKILL.md` and covers the shared 2D/3D composition,
ImageGen brief, visual QA, deterministic PNG validation, UI mapping, and character-art attribution.

A voice license is not character-art permission. The contribution must identify the visual terms,
must not commit an upstream reference sheet unless redistribution is allowed, and must keep the
session card fully functional when no authorized scene exists.

## Pull requests

Keep each PR focused. Complete the template with:

- problem and design rationale;
- affected platform/process boundaries;
- safety/failure/recovery behavior;
- privacy/network/storage changes;
- third-party/license changes;
- exact verification commands and results;
- screenshots only when UI behavior changed, with private data removed.

Maintainers may request a smaller change, more failure injection, or contract evidence before
reviewing product polish. A generated local installer is not release evidence; see
[Release engineering](docs/RELEASE.md).

## Commit guidance

Use clear imperative commit subjects. Describe user-visible behavior, protocol changes, new
dependencies/materials, security/privacy changes, and platform status changes in the pull request.
Do not mark a platform supported without maintainer release approval and qualification evidence.

## License of contributions

By submitting original launcher code, you agree that it may be distributed under the repository's
MIT License. You must have the right to submit the contribution. Third-party and copyleft material
must remain clearly separated and retain its applicable license and notices.
