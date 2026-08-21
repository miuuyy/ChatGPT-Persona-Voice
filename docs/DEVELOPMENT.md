# Development

This guide covers the three target-native paths:

- Apple Silicon macOS 14.2+ with Apple MPS;
- Windows x64 build 20348+ with NVIDIA CUDA and VB-CABLE installed separately from VB-Audio;
- Linux x64 with NVIDIA CUDA, PipeWire, and WirePlumber 0.4 or 0.5.

macOS, Ubuntu 24.04/WirePlumber 0.4, and Fedora 42/PipeWire 1.4.11/WirePlumber 0.5.14 have live
relay acceptance evidence. The packaged Windows path still needs broader clean-host feedback.

## Prerequisites

### Common

- Git
- Bun 1.3.14, matching `packageManager`
- Node.js 22.12 or newer
- [`uv`](https://docs.astral.sh/uv/) 0.11.14 for source engine setup
- network access for the first JavaScript/Python/model install

### Platform toolchains and runtime

| Platform | Required for target-native development |
| --- | --- |
| macOS arm64 | macOS 14.2+, Xcode Command Line Tools, Apple MPS |
| Linux x64 | C++20 compiler, `pkg-config`, PipeWire development headers/runtime, WirePlumber, supported NVIDIA GPU/driver |
| Windows x64 | Windows build 20348+, Visual Studio/MSVC, CMake, Windows SDK, supported NVIDIA GPU/driver, VB-CABLE |

Install VB-CABLE from its [official page](https://vb-audio.com/Cable/), run its setup as
administrator, and restart Windows. Persona Voice does not bundle or redistribute it.

The engine installer estimates approximately 2.5 GiB installed and 6 GiB minimum free on macOS,
9 GiB installed and 15 GiB free on Windows, and 11 GiB installed and 15 GiB free on Linux. Keep
additional space for dependencies and native build products.

## Checkout and install

```bash
git clone --recurse-submodules https://github.com/miuuyy/ChatGPT-Persona-Voice.git
cd ChatGPT-Persona-Voice
bun install --frozen-lockfile
```

If the repository was cloned without submodules:

```bash
git submodule update --init --recursive
```

The Seed-VC submodule commit must match `engine/seed-vc/model-lock.json`. Setup reports an error
instead of silently using another revision.

## Platform preparation

### macOS

Verify the target-native toolchain:

```bash
xcode-select -p
clang --version
```

The first live capture prompts for macOS Audio Capture permission. Persona Voice does not bypass
TCC. Intel macOS has no qualified realtime engine profile.

### Linux

Install the equivalent of these Ubuntu development/runtime packages:

```bash
sudo apt-get install build-essential pkg-config libpipewire-0.3-dev pipewire wireplumber
```

The first-run/Settings system-audio screen can install or remove the managed per-user policy and
restart the user audio services through a worker thread. Contributors can inspect or invoke the same
implementation directly:

```bash
node scripts/linux-audio-policy.cjs inspect
node scripts/linux-audio-policy.cjs install --reload
```

The installer refuses to replace unmanaged files at its fixed destinations. It writes a versioned
PipeWire ingress/bypass configuration plus the matching WirePlumber 0.4 or 0.5 policy and records an
activation receipt. Remove it with:

```bash
node scripts/linux-audio-policy.cjs remove --reload
```

The complete source path is live-proven on Ubuntu 24.04 with WirePlumber 0.4 and Fedora 42 with
PipeWire 1.4.11 / WirePlumber 0.5.14. The Fedora acceptance covered A/B dynamic streams, per-route
mute, SIGKILL/parent-death restoration, and uninstall cleanup.

### Windows

The user-mode helper build produces:

```text
cpv-audio-capture.exe
cpv-audio-output.exe
cpv-audio-route.exe
```

The in-app system-audio screen detects the official VB-CABLE render endpoint but does not mutate
per-app audio policy. Assign ChatGPT/Codex to **CABLE Input** under **Settings → System → Sound →
Volume mixer**, verify the live route, and keep Persona Voice standby active. Restore the app to
**Default** or the physical device before removing VB-CABLE.

## Engine setup

```bash
bun run setup:engine
```

The command resolves one exact profile from the current OS/architecture:

| Host | Profile |
| --- | --- |
| macOS arm64 | `darwin-arm64-mps` |
| Windows x64 | `windows-x64-cuda130` |
| Linux x64 | `linux-x64-cuda130` |

It then:

1. verifies pinned `uv` and the Seed-VC submodule;
2. creates `runtime/seed-vc/.venv` with managed Python 3.11;
3. synchronizes the platform-specific hash-locked Python requirements;
4. performs a real MPS or CUDA tensor probe before model acquisition;
5. downloads seven model files at pinned revisions and verifies every SHA-256;
6. writes a manifest bound to the runtime profile and requirements-lock hash;
7. enforces the 15 GiB runtime ceiling and removes temporary installer caches.

There is no CPU fallback and no automatic platform/profile substitution. Inference is configured
offline after setup.

Packaged applications expose the same profile resolution through **Settings → Voice → Install
engine**, using the embedded pinned `uv` and platform lock. That implementation does not by itself
prove a clean distributable; see [Release engineering](RELEASE.md).

## Run the app

```bash
bun run dev
```

`dev` builds and self-tests the native helpers for the current OS before starting Vite and Electron.
Start ChatGPT or Codex so source discovery has a live process tree/stream. On Linux/Windows, the
first-run system-audio step installs or verifies the platform route before the engine step. Linux
needs the managed policy installed/reloaded; Windows needs the signed sink installed by the elevated
app installer and may need the per-app Volume Mixer assignment described above.

To isolate development data from a normal install, set an absolute directory with the syntax for
your shell:

```bash
CODEX_PERSONA_VOICE_DATA_DIR=/absolute/path/to/dev-data bun run dev
```

`CODEX_PERSONA_VOICE_CODEX_BIN` may point to an absolute Codex CLI executable for capability
detection. The App Server audio bridge is still unimplemented; detecting the CLI does not enable
that source mode.

## Verification ladder

Run the smallest relevant check while iterating, then the full non-permissioned suite before a PR:

```bash
bun run test
bun run typecheck
bun run build:renderer
bun run check
bun run build:native
bun run test:native
```

`build:native` and `test:native` dispatch to the current platform. Normal CI runs frozen install,
tests, typecheck, renderer build, native compilation, and native self-tests on macOS, Windows, and
Linux. Linux native self-tests use a private PipeWire session. These commands verify build/protocol
contracts, not permissioned live routing, clean installation, CUDA latency, or release support.

### Engine smoke

```bash
bun run smoke:engine
```

The smoke uses a bundled credited reference/source sample and writes ignored output beneath
`artifacts/`. It validates the current MPS/CUDA CPVE worker on the executing host but is not an
end-to-end latency result.

### macOS permissioned smokes

```bash
bun run smoke:capture:mac
bun run smoke:output:jitter:mac
```

These affect local TCC/audio state. Run them interactively and include host/OS/hardware details with
results. Linux live acceptance requires a real user PipeWire/WirePlumber session and the installed
policy; Windows live acceptance requires VB-CABLE and explicit route-restoration
evidence. The generic native self-tests do not replace those runs.

## Repository map

| Path | Purpose |
| --- | --- |
| `src/` | React renderer and original design-system implementation |
| `src/locales/` | Complete English, Japanese, and Simplified Chinese catalogs |
| `electron/` | Main process, platform adapters, IPC, persistence, and protocol parsers |
| `native/macos/` | Objective-C++ Core Audio capture/output helpers |
| `native/linux/` | PipeWire capture/output plus WirePlumber 0.4/0.5 policy assets |
| `native/windows/` | WASAPI process-loopback, route verifier, and bounded output helpers |
| `native/shared/` | CPV1 native protocol layout |
| `engine/seed-vc/` | CPVE worker, platform locks, model verification, installer inputs |
| `engine/vendor/seed-vc/` | Pinned GPL-3.0 Seed-VC source submodule |
| `voices/` | Target-voice manifest and integrity-checked WAV references |
| `scripts/` | Target-native build, engine setup, policy, packaging, and smoke commands |
| `docs/` | Architecture, protocols, privacy, platform, and release truth |

Model weights, Python environments, caches, native build products, artifacts, history, and logs are
generated in ignored paths and do not belong in source control.

## Change rules

- Keep changes surgical. Do not add compatibility shims, hidden fallback engines, source-audio
  substitution, or fake readiness.
- Preserve source → suppression → engine → output transaction ordering.
- Keep all three locale catalogs on the same complete key and placeholder contract.
- Add tests when changing protocol fields, route states, queue bounds, timeouts, persistence schema,
  driver/policy lifecycle, or capability codes.
- Update the matching contract and platform/release status in the same pull request.
- Do not commit model caches, virtual environments, native output, smoke WAVs, logs, or user data.
- Do not add a target voice without authorization evidence, immutable hashes, terms URL, required
  credit, and privacy/license review.
- Keep third-party code and generated/native assets attributable in `THIRD_PARTY_NOTICES.md`.

## Packaging during development

Package only on the matching target host:

```bash
bun run package:mac
bun run package:win
bun run package:linux
```

Cross-packaging is rejected. The artifacts remain experimental:

- macOS lacks final Developer ID signing/notarization and clean-machine qualification;
- Linux AppImage packaging includes the per-user policy assets and in-app install/remove/reload
  lifecycle, but clean-machine recovery and broader distribution coverage remain to qualify;
- Windows packaging includes only the three user-mode helpers. VB-CABLE remains a separate
  user-installed prerequisite and is never copied into the package.

The `v0.1.1` tag workflow builds macOS, Windows, and Linux preview packages, regenerates one
canonical `SHA256SUMS`, signs that manifest, and creates a draft GitHub Release. Artifact transport
is not support evidence.

## Pull requests

Before opening a PR:

1. run `bun install --frozen-lockfile` from a clean dependency state when the lock changed;
2. run `bun run check`;
3. run target-native and engine checks when their code/contracts changed;
4. confirm [Platform matrix](PLATFORM_MATRIX.md) distinguishes implementation, live proof,
   distribution gates, and support;
5. review privacy, licensing, driver/policy lifecycle, and recovery implications;
6. include exact commands, host details, and outcomes.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for issue and pull-request expectations.
