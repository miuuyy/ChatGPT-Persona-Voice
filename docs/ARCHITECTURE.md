# Architecture

Status: the native relay is implemented and live-accepted for Apple Silicon macOS and NVIDIA Linux
x64. Windows x64 has a packaged WASAPI/VB-CABLE path, standby lifecycle, and CUDA engine setup, but
still needs clean physical-Windows end-to-end acceptance. This is not release assurance.

## Product boundary

Codex Persona Voice is a standalone, local-first desktop audio relay. It is not an MCP server, an
OpenAI component, or a Persona extension. It owns its renderer, settings, process discovery,
platform audio route, conversion worker, output helper, and optional local history.

The design invariant is:

> Converted playback may begin only after the selected source proves that its original route is
> suppressed. If route ownership or any downstream stage is lost, the relay reports a fault or an
> uncertain restoration state instead of substituting the original voice.

An implemented adapter is not automatically a supported release. Clean-machine, signing, recovery,
and performance gates remain in [Release engineering](RELEASE.md).

## Process and trust boundaries

| Process/component | Responsibility | Trust boundary |
| --- | --- | --- |
| Electron renderer | Presentation and user intent | Sandboxed, context-isolated, no Node.js |
| Electron main | Validated IPC, settings, discovery, pipeline lifecycle, history, logs | Resolves filesystem paths and child processes |
| Platform capture/route helper | Process-scoped route ownership, suppression proof, CPV1 PCM | Native child process; Core Audio, PipeWire, or WASAPI |
| VB-CABLE Input on Windows | Separately installed virtual endpoint used as the suppressing boundary | Third-party signed driver from VB-Audio; never bundled by Persona Voice |
| Seed-VC worker | Local model load, streaming conversion, SOLA state | Separate GPL Python process over CPVE pipes |
| Platform output helper | Exact-format converted playback and bounded buffering | Native child process over CPV1 |

The preload exposes a narrow IPC API. Renderer navigation is limited to the local development origin
or packaged renderer file; new windows are denied. Terms and repository links are opened by explicit
main-process handlers.

## Source backends

### macOS: Core Audio process tap

The macOS path resolves stable application roots for a selected or automatic ChatGPT/Codex process
tree and refreshes descendants while running. It initially observes process I/O without creating a
tap. When the process tree has active input and new audible output, the helper creates a private
Core Audio process tap and aggregate device, verifies the format and first frame, then engages
`CATapMutedWhenTapped`. After input has stopped for 750 ms it restores `CATapUnmuted`, closes the
active tap, and returns to `armed`.

Transparent process taps require macOS 14.2 or newer; the qualified realtime engine requires Apple
Silicon MPS. This path has been manually accepted live.

### Linux: owned PipeWire/WirePlumber ingress

The Linux platform-audio controller installs/removes versioned per-user policy in a worker thread and
restarts the user audio services without restarting Persona Voice; playback pauses briefly while the
app stays open. PipeWire creates an owned virtual
ingress and passive bypass for deterministic `chatgpt`/`codex` routes. WirePlumber 0.4 or 0.5 policy
matches supported application identities before normal target selection and links them to that
ingress. While idle, the bypass forwards source PCM to the current physical default.

The native capture helper opens the owned ingress monitor, creates a guarded capture stream, proves
the pre-link policy and capture links, then mutes and rechecks the bypass before reporting
`engaged`. It owns a 64-slot capture queue and reports topology restoration uncertainty if bypass
unmute or helper shutdown cannot be proven. Source resolution combines PipeWire stream identity
with `/proc` process trees and supports dynamic ChatGPT/Codex streams.

The x64 `linux-x64-cuda130` engine profile and native PipeWire output helper complete the local data
path. Live acceptance covers Ubuntu 24.04 with WirePlumber 0.4 and Fedora 42 with PipeWire 1.4.11 /
WirePlumber 0.5.14.

### Windows: WASAPI plus VB-CABLE

Windows process-scoped WASAPI loopback captures one selected process tree on build 20348 or newer.
Loopback alone cannot silence the app's normal endpoint, so the suppressing boundary is the
separately installed VB-CABLE render endpoint. The route verifier identifies the official driver by
its endpoint description and adapter properties, proves that current live sessions for the selected
process tree are attached to that exact endpoint, and monitors session changes. It
explicitly declares `routeMutation: false`: it verifies policy but does not assign it.

The current lifecycle uses bounded process-loopback standby passthrough from VB-CABLE Input to the physical
default while conversion is idle, then transfers the captured frames to the conversion pipeline.
Converted PCM returns through a bounded WASAPI shared-render output helper. The x64
`windows-x64-cuda130` profile supplies the local CUDA engine.

Persona Voice never downloads or bundles VB-CABLE. The in-app platform-audio step opens the official
VB-Audio page, asks the user to install the signed driver and restart Windows, then guides assignment
and starts standby verification. Users assign ChatGPT/Codex to **CABLE Input** in Volume Mixer and
restore it to Default or the physical device before removing VB-CABLE.

Graceful Quit is blocked while the retained route may persist and requires user-confirmed
restoration. The OS does not expose proof that the persistent per-app preference was reset, and a
crash/force-kill can leave the source assigned to VB-CABLE Input. Monitoring proves only current
live sessions; `OnSessionCreated` is not guaranteed before a session's first sample.

### Owned Codex realtime session: contract only

An owned App Server session could receive assistant PCM before hardware playback and avoid OS route
interception. The capability is described in the adapter architecture, but the source bridge is not
implemented. Detecting the Codex CLI does not enable it.

## Data path

```text
selected ChatGPT/Codex process tree
        │
        ▼
platform route adapter
  macOS: detached tap → muted process tap
  Linux: owned ingress + bypass → guarded capture + bypass mute
  Windows: assigned VB-CABLE Input + standby → verified process-loopback capture
        │ CPV1 f32le, only after platform engagement proof
        ▼
Electron conversion queue (1,000 ms target; 6,000 ms safety bound)
        │
        ▼
Seed-VC adapter: discard first 3 s → accumulate 300 ms → CPVE convert
        │
        ▼
22.05 kHz mono f32le, split into 20 ms frames
        │
        ├── Core Audio / PipeWire / WASAPI native output
        ├── optional converted-only WAV history
        └── optional converted-only BlackHole mirror on macOS
```

Frames carry explicit metadata:

```text
sequence, itemId, capturedAt, sampleRate, channels, sampleFormat, samplesPerChannel, pcm
```

Every active stage validates sample rate, channel count, format, duration, sequence, and PCM byte
length. No platform or engine path guesses an undeclared format.

## Lifecycle

### Start and prepare

1. Probe source, route/suppression, engine, and output capabilities.
2. Describe the source's exact PCM format.
3. Prepare and warm the matching MPS or CUDA engine profile.
4. Acquire the platform route guard and require an explicit armed/readiness contract.
5. Open capture callbacks and transition into the platform's idle/armed state.

macOS holds no converted output helper while merely armed. Linux's persistent policy keeps its owned
bypass audible. Windows may keep its bounded standby capture/output active after explicit per-app
assignment so the source remains audible before and between conversions.

Stop is valid during startup. It cancels the active generation, waits for late resources, and uses
the normal ordered rollback. Quit seals mutating IPC, drains the pipeline, shuts down the engine,
then releases platform-owned route resources.

### Engage

The proof differs by platform:

| Platform | Engagement proof |
| --- | --- |
| macOS | Active duplex process I/O, valid Core Audio tap format, first PCM frame, muted-tap state |
| Linux | Owned ingress capture link, pre-link policy receipt, captured PCM, verified bypass mute |
| Windows | Selected live process sessions on the exact owned sink, armed route verifier, process-loopback readiness |

After proof:

1. Electron transitions `armed → engaging`.
2. The already-loaded engine repeats bounded warmup.
3. Electron prepares exact-format native output.
4. The runtime transitions to `running` and accepts capture frames.
5. Seed-VC discards the first three seconds for the newly prepared/reset session, then converts
   fixed 300 ms blocks into 20 ms output frames.

Reference conditioning has two independent bounds: a 3-second acoustic prompt used in every
diffusion block and a one-time CAMPPlus speaker embedding from up to 17 seconds of the reference.
Frames received before `running` are not replayed as unconverted output.

### Disengage and stop

When a platform adapter reports disengagement, Electron resets the engine, drains serialized work,
closes converted output, and clears queue accounting. Explicit Stop closes processing first and
releases the route guard last. If processing or restoration cannot be proven, the runtime retains a
faulted/uncertain state rather than claiming a clean stop.

- macOS unmutes and closes the tap before returning to detached observation.
- Linux unmutes the owned bypass and removes the guarded capture link; policy files remain installed
  until the explicit policy remove workflow.
- Windows returns from conversion to bounded standby. While the manual route may persist, graceful
  quit/uninstall blocks for explicit Volume Mixer restoration and user confirmation because the
  verifier cannot prove that the persistent per-app policy was reset.

Allowed pipeline states remain:

```text
stopped → starting → armed → engaging → running
                    ▲          │           │
                    └──────────┴───────────┘

armed / engaging / running → faulted → stopping → stopped
armed / engaging / running ─────────→ stopping → stopped
```

## Fault semantics

- Failed readiness leaves the relay stopped.
- Startup rollback closes source/output/engine before releasing suppression ownership.
- Invalid PCM, sequence gaps, capture overflow, conversion errors/timeouts, output errors, and
  unexpected route/helper exits are terminal to the active relay session.
- Processing faults do not enable an unverified original-audio fallback.
- A helper that cannot prove restoration reports `suppressionHeld` or `suppressionUncertain`; cleanup
  evidence is not synthesized from process exit alone.
- Windows session notifications are not guaranteed to precede first audio. Losing the target's sink
  membership is a route failure, not permission to continue conversion.
- Engine shutdown requires reset/quiescence before output and route release.

## Bounds and timing

| Boundary | Current value |
| --- | ---: |
| Maximum CPV1 native payload | 16 MiB |
| macOS/Linux native capture queue | 64 slots |
| JavaScript queued source duration | 6,000 ms safety bound |
| Seed-VC source block | 300 ms |
| Seed-VC conversion request timeout | 8,000 ms |
| Seed-VC control timeout | 5,000 ms |
| Engine output frame | 20 ms |
| macOS/Linux maximum output frame | 40 ms |
| macOS/Linux output queue | 64 frames/buffers; 500 ms startup target |
| Windows converted output | 80 ms maximum frame; 500 ms startup; 1,500 ms capacity |
| Windows standby output | 40 ms startup; 250 ms capacity |

These are implementation limits, not an end-to-end latency SLO. They do not include capture, the
three-second discard, scheduling, or hardware playback. `500 ms` is an output prebuffer target, not
proof of 500 ms user-visible latency.

## Persistence and privacy

Electron stores state beneath its configured user-data directory. JSON state and history indices
use atomic replacement; POSIX-capable systems receive private modes where possible.

- Logs are bounded JSON Lines diagnostics and do not intentionally contain PCM, but can contain
  process paths, device names, adapter errors, or bounded child stderr.
- Raw source PCM is not intentionally persisted. History accepts converted frames only after they
  are submitted to output.
- Converted history is PCM16 WAV and is disabled by default. Default retention is six hours;
  disabling history does not delete existing files.
- Linux policy files live in per-user XDG configuration/data roots and have explicit in-app
  install/remove/reload actions. VB-CABLE is installed separately from VB-Audio; Windows per-app
  Volume Mixer policy remains OS-owned and may require manual restoration.

See [Privacy](PRIVACY.md) for network, storage, permission, and deletion boundaries.

## Implemented and remaining

Implemented in the development tree:

- Electron renderer, validated preload IPC, tray/autostart, local state, and diagnostics;
- macOS Core Audio and Linux PipeWire/WirePlumber relay adapters, plus the packaged Windows
  WASAPI/VB-CABLE path awaiting broader physical-host acceptance;
- native capture/output helpers and CPV1 framing on all three target platforms;
- pinned MPS and x64 CUDA 13.0 Seed-VC profiles, CPVE worker, and verified source/in-app installer;
- twelve integrity-checked VOICEVOX references, one community JARVIS reference, and one disclosed
  upstream Seed-VC Donald Trump AI-likeness reference;
- converted-only history and the optional macOS BlackHole mirror;
- target-native packaging/update plumbing and cross-platform contract/native self-tests.

Remaining or externally blocked:

- Windows VB-CABLE install/assignment/restore and crash/restart recovery qualification;
- Linux clean packaged policy recovery qualification and broader distribution/session coverage;
- production signing/notarization, supported installers, and clean-machine qualification;
- representative end-to-end latency and long-session recovery evidence;
- Intel macOS, non-NVIDIA Windows/Linux, and other architecture profiles;
- the owned Codex App Server realtime bridge and a stable external engine SDK.

## Related contracts

- [Platform matrix](PLATFORM_MATRIX.md)
- [CPV1 native protocol](NATIVE_PROTOCOL.md)
- [Voice engine contract](ENGINE_CONTRACT.md)
- [Model adapter guide](MODEL_ADAPTERS.md)
- [Engine SDK plan](ENGINE_SDK.md)
