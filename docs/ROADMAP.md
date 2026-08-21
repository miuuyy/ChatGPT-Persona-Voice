# Roadmap

This roadmap is evidence-driven and carries no delivery dates. A milestone is complete only when
its tests and artifacts exist in the repository or a reviewed acceptance/release record.

## Implemented baseline

- Apple Silicon macOS 14.2+ Core Audio route, MPS engine profile, and native output, with a manually
  accepted live relay.
- Linux x64 PipeWire/WirePlumber per-app ingress/bypass policy, native capture/output, and CUDA
  engine profile, with Ubuntu 24.04/WirePlumber 0.4 and Fedora 42/PipeWire 1.4.11/WirePlumber
  0.5.14 live acceptance.
- Windows x64 process-scoped WASAPI capture/output, verified external VB-CABLE route, bounded
  standby lifecycle, and CUDA engine profile.
- Cross-platform source/in-app engine installer contracts and target-native build/self-tests.

These are implementation facts, not supported-release claims.

## Now: distribution and recovery truth

- Keep architecture, protocols, platform matrix, troubleshooting, and release status synchronized
  with code and live evidence.
- Build a versioned end-to-end latency harness; do not use inference time or a 500 ms prebuffer as a
  user-visible latency result.
- Expand failure injection across source/output changes, helper/engine/app crash, logout/restart,
  update/uninstall, and unresolved route restoration.
- Qualify engine install/resume/remove and future lock migration on clean machines for every target.
- Publish exact known limitations without collapsing implemented, live-proven, distributable, and
  supported into one status.

## Gate A: Windows qualification

- Qualify the external VB-CABLE install, reboot, detection, assignment, restoration, and removal flow.
- Qualify and harden the current in-app verification plus explicit Volume Mixer
  assignment/restoration lifecycle (or replace it with a separately reviewed deterministic
  mechanism), including the notification-before-audio gap.
- Prove bounded standby audibility and original-audio suppression across session recreation.
- Add Authenticode, SmartScreen/reputation, clean-machine NVIDIA, and end-to-end performance evidence.

## Gate B: Linux packaged lifecycle

- Qualify the implemented in-app managed-policy install/remove/reload UX, conflict refusal, and
  rollback when audio-service restart fails.
- Qualify stream recreation, default-device/daemon changes, crash, logout, update, and uninstall.
- Test clean AppImage engine installation on named NVIDIA GPU/driver combinations.
- Broaden distribution/desktop coverage only from real route evidence.

Ubuntu 24.04/WirePlumber 0.4 and Fedora 42/PipeWire 1.4.11/WirePlumber 0.5.14 are the current
accepted live baselines.

## Gate C: macOS distributable preview

- Qualify clean engine install/resume/remove and Audio Capture grant/denial/revocation.
- Sign every nested executable, enable the reviewed hardened runtime, notarize, and staple.
- Complete crash/restart/update/uninstall route-restoration coverage.
- Publish named-hardware first-audio, steady-state, underrun, memory, and thermal results.

## Gate D: stable engine boundary

- Extract CPVE schemas, golden vectors, fake engine, and black-box conformance suite.
- Separate the process runner from Seed-VC-specific behavior.
- Define capability negotiation, package provenance, install manifests, and version rejection.
- Migrate Seed-VC through the generic boundary without a compatibility shim.
- Qualify a second independent adapter before publishing an SDK.

See [Engine SDK plan](ENGINE_SDK.md).

## Gate E: owned Codex realtime source

- Implement an App Server bridge that receives typed realtime PCM before hardware playback.
- Map item ids, interruption/cancellation, and reset into `PipelineRuntime`.
- Prove that owned PCM is never attached to hardware before conversion.
- Keep this backend distinct from interception of an existing desktop WebRTC session.

Codex CLI discovery does not satisfy this gate.

## Later candidates

- Persona speaking-state/level event bridge after the relay contract is stable.
- Additional authorized voice catalogs and model adapters.
- Explicit log retention/export controls.
- Accessibility localization and broader keyboard/screen-reader qualification.
- Privacy-preserving diagnostics export with user review/redaction.
- Additional OS/architecture/accelerator profiles only after measured realtime qualification.

## Non-goals

- Hidden source-audio or identity conversion to make readiness look successful.
- Keyword or OS-name routers that override adapter evidence.
- Silent model/profile downgrade.
- Bundling third-party drivers or shipping unverified model downloads.
- Claiming sub-second or p95 latency from a single inference microbenchmark.
- Bundling OpenAI proprietary branding/assets or implying official product status.
