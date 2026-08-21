# Release engineering

Status: `v0.1.1` is the preview release for macOS, Windows, and Linux. Windows uses VB-CABLE as a
separately installed prerequisite and still needs broader physical-host acceptance.

The repository contains complete live-accepted source paths for Apple Silicon macOS and NVIDIA
Linux x64. Windows x64 packages process-loopback capture, output, VB-CABLE route verification,
standby lifecycle, and CUDA engine setup, but has limited clean physical-Windows E2E evidence.
Implementation and development evidence do not complete distribution qualification.

## Current artifact policy

- `bun run package:mac`, `package:win`, and `package:linux` are target-host packaging commands, not
  support declarations. Cross-target packaging is rejected.
- Normal CI does not publish. A `v*` tag matching `package.json` starts target-native macOS ARM64,
  Windows x64, and Linux x64 packaging jobs.
- Local packaging writes `SHA256SUMS`. Tag publication regenerates one canonical manifest covering
  all uploaded artifacts/notices and signs its exact bytes with the protected Ed25519 update key.
- All target packages carry the small pinned `uv` bootstrap and platform engine lock; the large
  Python/model runtime is installed separately into private application data.
- macOS local packaging is ad hoc without a configured signing identity and is not notarized.
- Linux AppImage packaging includes native PipeWire helpers, policy assets, and in-app
  install/remove/reload actions, but clean recovery and broader distribution/session qualification
  remain.
- Windows packages only the user-mode WASAPI helpers. The app links to the official VB-CABLE page;
  VB-CABLE is installed, updated, and removed separately by the user.
- Any generated DMG, ZIP, EXE, or AppImage remains experimental until its platform gates below pass.

## GitHub Releases update channel

Packaged launchers check `miuuyy/ChatGPT-Persona-Voice` once at startup. Development runs do not use
the update channel. A newer release is offered only when:

1. the latest tag is valid semver and newer than the packaged version;
2. the release contains the exact OS/architecture artifact name;
3. the artifact, `SHA256SUMS`, and `SHA256SUMS.sig` URLs bind to the exact repository/tag over HTTPS;
4. the manifest signature verifies against the embedded public key;
5. the artifact matches its signed SHA-256 entry.

Only then can a detached worker run. Electron first stops/drains the relay and engine; if safe
shutdown fails, the update is cancelled and the installed app remains untouched. macOS uses the
native `renameatx_np(RENAME_SWAP)` helper for atomic exchange. The package carries pinned Bun 1.3.14
only for the detached updater, with its version-specific notice.

The signed manifest authenticates project release assets; it does not replace platform trust.
Developer ID/notarization, Windows Authenticode/SmartScreen, and Linux distribution/package trust
remain separate gates. The private Ed25519 key is absent from the repository and publication stops
unless the protected `release-signing` environment supplies `UPDATE_SIGNING_PRIVATE_KEY`.

When the repository is private, the client has no embedded GitHub token, so unauthenticated update
discovery returns no usable release. Public repositories use the same unauthenticated endpoint and
still require the project manifest signature.

## Cross-platform packaged engine boundary

Application artifacts exclude the large Python environment and model cache. Resources contain
pinned `uv` 0.11.14, the platform requirements lock, model lock, verifier, worker, and pinned
Seed-VC source. **Settings → Voice → Install engine**:

1. selects exactly `darwin-arm64-mps`, `windows-x64-cuda130`, or `linux-x64-cuda130` from the host;
2. acquires managed Python 3.11;
3. synchronizes the exact hash-locked packages (including the CUDA backend where required);
4. proves MPS/CUDA with a real tensor operation;
5. downloads and hashes all seven locked model files;
6. atomically publishes a manifest bound to the profile and requirements-lock digest.

Cancellation preserves staging for resume. A previous valid runtime remains until replacement
verification passes; interrupted publication is reconciled on next launch. Remove is scoped to the
engine runtime, staging, managed Python, and installer cache.

| Profile | Estimated installed | Minimum free |
| --- | ---: | ---: |
| macOS arm64 MPS | 2.5 GiB | 6 GiB |
| Windows x64 CUDA | 9 GiB | 15 GiB |
| Linux x64 CUDA | 11 GiB | 15 GiB |

No terminal, global Python, or voice API key is required in the packaged installer. This mechanism
still needs clean-machine/version-migration qualification on every claimed platform.

## Common release gates

Every platform release must prove:

- clean install, update, downgrade policy, removal, and recovery on named OS/hardware;
- deterministic source identity, route engagement/disengagement, and original-audio restoration;
- failure injection for source/output changes, helper/engine/app crash, suspend/resume,
  logout/restart, updater failure, and uninstall;
- versioned end-to-end p50/p95/p99 first-audio and steady-state latency, underruns, long-session
  memory/thermal behavior, and voice-quality review;
- final platform signing/distribution trust and nested executable verification;
- a reviewed privacy/security boundary for driver/policy, installer, updater, child processes, and
  local history;
- a final license/SBOM/provenance audit and matching third-party notices.

Inference-only timing and `startupPrebufferMs: 500` do not satisfy the latency gate.

## macOS release gates

The Core Audio/MPS data path is implemented and manually accepted live. Remaining gates include:

- clean Audio Capture grant/denial/revocation and route recovery across supported macOS versions;
- clean engine install/resume/remove and future lock-to-lock migration;
- Developer ID signing for the app and nested native/Python executables;
- hardened-runtime/entitlement review, Gatekeeper assessment, notarization, and stapling;
- crash/restart/update/uninstall restoration and the common performance gates.

Local ad-hoc DMG/ZIP creation is not public-install qualification.

## Linux release gates

The native PipeWire/WirePlumber route, output helper, and CUDA engine profile are implemented. Live
proof covers Ubuntu 24.04/WirePlumber 0.4 and Fedora 42/PipeWire 1.4.11/WirePlumber 0.5.14; the
Fedora run covered A/B dynamic streams, per-route mute, SIGKILL/parent-death restoration, and
uninstall cleanup. Remaining gates include:

- clean-machine qualification of the implemented in-app install/remove/reload ownership for managed
  per-user PipeWire/WirePlumber files, including rollback when a user audio-service restart fails;
- restoration after stream recreation, default-device/daemon changes, app crash, logout, update,
  and uninstall;
- clean AppImage engine setup on named NVIDIA hardware/driver combinations;
- distribution/session coverage, artifact signing/provenance policy, and common performance gates.

`pw-dump` or a passing private-PipeWire self-test is useful evidence, but neither replaces the live
desktop route and recovery matrix.

## Windows release gates

The repository implements process-scoped WASAPI capture, bounded physical output, strict recognition
of the official VB-CABLE Input endpoint, current-session route verification, bounded standby
passthrough, and the x64 CUDA engine/install profile. VB-CABLE is not a release asset.

Windows still needs:

- clean VB-CABLE install/reboot/assignment/restore and recovery evidence;
- Authenticode signing and installer reputation/SmartScreen testing;
- exact Windows/NVIDIA version qualification;
- qualification and recovery coverage for the current in-app route UX: the verifier does not mutate
  persistent per-app routing, current live-session notifications are not guaranteed pre-audio, and
  users assign ChatGPT/Codex to CABLE Input in Volume Mixer and restore it before removing VB-CABLE;
- proof that standby remains audible and bounded, conversion never leaks the original source, and
  route loss/manual restoration cannot be mistaken for success;
- clean physical-Windows UAC/install/rollback/audio and NVIDIA execution evidence; source, CI, and
  engine-profile contracts alone are not GPU/performance proof;
- the common clean-machine, performance, security, and licensing gates.

WASAPI loopback alone is not original-route suppression. VB-CABLE plus proven app assignment is the
boundary.

## Licensing checklist

Final artifacts must deliver and audit:

- MIT terms for original launcher code;
- GPL-3.0 and corresponding-source obligations for the Seed-VC worker distribution;
- model licenses/terms for every downloaded or redistributed weight;
- credits, terms, and hashes for twelve bundled VOICEVOX references;
- community JARVIS attribution and hash;
- the disclosed Donald Trump AI-likeness reference attribution and hash;
- notices matching the exact final native/runtime contents.

## Release procedure once gates pass

1. Freeze reviewed scope and write release notes from reviewed changes.
2. Run frozen install, tests, typecheck, renderer build, native tests, engine conformance, and
   permissioned end-to-end qualification on named hosts.
3. Audit dependency/model locks, Seed-VC revision, voices, licenses, driver/policy provenance,
   notices, and SBOM/provenance.
4. Build from a reviewed tag on each target OS, supplying signed platform inputs through protected
   environments only.
5. Verify installed app, nested signatures, engine setup, route policy/driver lifecycle,
   update/removal, permissions, history deletion, and benchmark thresholds on clean machines.
6. Publish the exact support matrix, checksums/signature, known limitations, rollback plan, privacy
   boundary, and license/source offers.
7. Monitor only through an explicitly reviewed privacy-preserving process; do not add telemetry for
   release convenience.

## Versioning

The package currently reports `0.1.1`; publication requires the exact matching `v0.1.1` tag (or the
matching future version). Until a public compatibility contract exists, CPV1, CPVE, settings, route
policy, and adapter changes may be breaking and must be called out in release notes.

See [Platform matrix](PLATFORM_MATRIX.md), [Roadmap](ROADMAP.md), and
[Security](../SECURITY.md).
