# Platform matrix

This matrix separates an implemented source path, live acceptance evidence, a clean distributable,
and a supported release. Those are different claims. No platform currently has a supported
production release.

## Current implementation

| Capability | Apple Silicon macOS 14.2+ | Windows x64 + NVIDIA, build 20348+ | Linux x64 + NVIDIA |
| --- | --- | --- | --- |
| Electron application | Implemented | Implemented | Implemented |
| Source discovery | ChatGPT/Codex process trees | ChatGPT/Codex process trees | PipeWire output streams plus `/proc` process scope |
| Existing-app capture | Core Audio process tap | Process-scoped WASAPI loopback | Native PipeWire capture from owned ingress monitor |
| Original-route control | `CATapMutedWhenTapped` after first-frame proof | Separately installed VB-CABLE Input; in-app setup verifies explicit per-app assignment, but does not mutate policy | In-app per-user PipeWire/WirePlumber policy setup, owned ingress/bypass, capture and bypass-mute proof |
| Idle playback | Original route remains attached while the tap is armed | Bounded standby passthrough from the assigned sink to physical output | Owned bypass stream forwards ingress to the current physical default |
| Converted output | Native Core Audio helper | Native WASAPI shared-render helper | Native PipeWire output helper |
| Engine profile | `darwin-arm64-mps` | `windows-x64-cuda130` | `linux-x64-cuda130` |
| Engine installation | Source and packaged in-app installer implemented | Source and packaged in-app installer implemented | Source and packaged in-app installer implemented |
| Live relay evidence | Manually accepted live | User-mode build/contract proof; awaiting v0.1.1 physical-host reports | Ubuntu 24.04 / WirePlumber 0.4 and Fedora 42 / PipeWire 1.4.11 / WirePlumber 0.5.14 accepted live |
| Remaining platform qualification | Signing/notarization, clean-machine and recovery matrix | Clean VB-CABLE install, Volume Mixer assignment/restore, CUDA, and recovery matrix | Clean packaged policy recovery and broader distribution/session coverage |
| Supported release | No | No | No |

Other architectures have no qualified realtime engine profile. Intel macOS, Windows ARM64, Linux
ARM64, CPU-only Windows/Linux, and other operating systems remain unsupported.

## macOS evidence

The Apple Silicon path includes:

- a macOS 14.2 capability probe and user-mediated Audio Capture permission;
- deferred process observation, `CATapMutedWhenTapped` engagement after format/first-frame proof,
  a 64-slot capture ring, dynamic process-tree refresh, and restoration reporting;
- exact-format Core Audio output with 64 bounded buffers, a 40 ms maximum frame, and explicit
  rebuffer status;
- the pinned Apple MPS Seed-VC profile and verified source/in-app engine installation;
- a manually accepted live relay path.

This does not complete Developer ID signing, notarization, clean-machine permission recovery,
update/uninstall recovery, or representative end-to-end latency qualification.

## Linux evidence

The implemented Linux x64 path includes:

- `pw-dump` discovery and `/proc`-based ChatGPT/Codex process scoping;
- an in-app setup controller and worker for versioned per-user PipeWire/WirePlumber policy files with
  deterministic ChatGPT/Codex route ids, owned ingress/bypass nodes, atomic managed-file
  replacement/removal, conflict refusal, and user-session reload;
- native CPV1 PipeWire capture that requires the pre-link policy, verifies owned ingress capture and
  bypass mute before engagement, handles dynamic process streams, and reports rollback uncertainty;
- native PipeWire output with a bounded 64-frame jitter queue and 500 ms startup/rebuffer target;
- the locked `linux-x64-cuda130` Seed-VC profile with an actual CUDA tensor probe before model
  acquisition;
- live Ubuntu 24.04 / WirePlumber 0.4 and Fedora 42 / PipeWire 1.4.11 / WirePlumber 0.5.14 relay
  proofs.

The Fedora 42 acceptance covered A/B dynamic streams, per-route mute, SIGKILL/parent-death
restoration, and uninstall cleanup. The first-run/Settings UI owns installation and removal;
contributors can run the same policy implementation directly with:

```bash
node scripts/linux-audio-policy.cjs install --reload
```

The AppImage includes the policy assets and in-app lifecycle. It still needs clean-machine
install/remove/reload rollback, daemon/device/crash recovery qualification, and broader
distribution/session coverage.

## Windows evidence and prerequisite

The Windows x64 preview path includes:

- process-scoped WASAPI loopback capture for one selected process tree on build 20348 or newer;
- bounded WASAPI shared-render output to the physical listening device;
- strict recognition of the base VB-CABLE Input endpoint installed separately from VB-Audio;
- a route verifier that proves the selected app's current live audio sessions are on that endpoint,
  monitors session changes, and declares that it does not mutate routing policy;
- an in-app system-audio step that guides assignment and starts a standby lifecycle which forwards
  captured sink audio to the physical output while conversion is idle, then hands the same route to
  conversion;
- the locked `windows-x64-cuda130` Seed-VC profile and cross-platform engine installer.

WASAPI process loopback does not suppress the normal endpoint by itself. The suppressing boundary is
VB-CABLE, which is signed and distributed by VB-Audio. Persona Voice opens the official download
page but never bundles, downloads, installs, updates, or removes that driver.

The current in-app route helper also has an explicit product limitation: it verifies current live sessions
but does not assign or restore per-app audio policy, and Windows notifications are not guaranteed to
arrive before the first audio frame. A run may therefore require the user to assign ChatGPT/Codex to
`CABLE Input` in **Settings → System → Sound → Volume mixer**, keep standby passthrough active,
and restore the app to **Default** or the physical device before quit/uninstall. Clean-binary and
recovery acceptance remain preview-quality until that lifecycle is qualified on more physical hosts.

Graceful Quit blocks on explicit restoration and user confirmation. A crash/force-kill can still
leave the OS-owned per-app preference pointing at the sink. The route monitor proves current live
sessions only; `OnSessionCreated` has no pre-first-sample guarantee. None of the checked-in Windows
source/contracts is a GPU/performance or clean physical-host proof.

## Cross-platform release gates

Every platform must independently prove all of the following before support is claimed:

1. Stable source identity and exact source PCM format.
2. A reversible route that proves original-audio suppression during converted playback and reports
   uncertainty instead of inventing restoration.
3. A qualified local engine profile with reproducible installation and complete license inventory.
4. Exact-format bounded output with tested underrun/overflow behavior.
5. Failure injection for source exit, sequence gaps, queue overflow, engine timeout/crash, output
   loss, device/daemon changes, app crash, logout/restart, and route restoration.
6. Clean install, update, downgrade policy, uninstall, and recovery on named hosts.
7. End-to-end latency/quality methodology and published results for named hardware.
8. Platform signing/distribution requirements and final third-party notice delivery.

## CI and release-workflow scope

Normal CI performs frozen dependency installation, tests, typecheck, renderer build, native helper
compilation, and non-permissioned native self-tests on macOS, Windows, and Linux. Linux self-tests run
inside a private PipeWire session. These checks prove build/protocol contracts, not permissioned
live routing, CUDA performance, clean installation, or release support.

The `v0.1.1` tag workflow builds target-native DMG/ZIP, NSIS, and AppImage artifacts and signs a
canonical update manifest. Windows native components compile and run contract self-tests in CI;
VB-CABLE itself is not a release asset. Transport, checksums, or a published artifact do not replace
the platform gates above.

See [Release engineering](RELEASE.md) for artifact policy and [Roadmap](ROADMAP.md) for the remaining
evidence sequence.
