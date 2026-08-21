# CPV1 native audio protocol

CPV1 is the bounded local protocol between Electron main and the macOS, Linux, and Windows native
capture/route/output helpers. It uses anonymous child-process pipes. No TCP port, shared audio file,
or raw-PCM log is part of the transport.

This is an internal version-1 contract, not a public compatibility promise.

## Framing

All integers are little-endian. Every frame begins with a packed 12-byte header:

| Offset | Field | Type | Constraint |
| ---: | --- | --- | --- |
| 0 | magic | `uint32` | bytes `CPV1` (`0x31565043`) |
| 4 | version | `uint16` | `1` |
| 6 | type | `uint16` | one of the values below |
| 8 | payload bytes | `uint32` | at most 16 MiB |

| Type id | Name | Payload |
| ---: | --- | --- |
| 1 | Ready | UTF-8 JSON with `type: "ready"` |
| 2 | Audio | 16-byte audio metadata followed by interleaved PCM |
| 3 | Error | UTF-8 JSON with `type: "error"` |
| 4 | Status | UTF-8 JSON with `type: "status"` |

Unknown versions/types, oversized payloads, invalid JSON, and truncated frames are terminal parser
errors. Ready, Error, and Status payloads must be JSON objects whose string `type` matches the
binary frame type.

## Audio payload

| Offset | Field | Type | Constraint |
| ---: | --- | --- | --- |
| 0 | sequence | `uint32` | wraps modulo 2^32 |
| 4 | sample rate | `uint32` | 8,000–192,000 Hz |
| 8 | channels | `uint16` | 1 or 2 |
| 10 | sample format | `uint16` | `1` = `f32le` |
| 12 | samples per channel | `uint32` | greater than zero |
| 16 | PCM | bytes | exactly `samples × channels × 4` |

Capture sequence gaps are terminal in Electron. Format changes after preparation are also terminal.

## Capture and route control

Capture helpers write Ready, Status, Audio, and Error frames to stdout. Electron accepts audio only
after the relevant platform route has proved its engaged state.

### Common route states

| State | Meaning |
| --- | --- |
| `armed` | Adapter owns a valid observation/route boundary; original playback is not suppressed by conversion |
| `engaged` | Adapter has platform-specific capture and original-route suppression proof |

The exact proof is platform-authored rather than inferred from the state name.

### macOS capture contract

The Core Audio helper declares `supportsArming`, `supportsDeferredTap`, `supportsCaptureProof`, and
`activationSignal: "duplex_process_io"`. Armed status requires no tap and no suppression. Engaged
status requires the selected process-object set, valid format/first PCM, active tap, and
`CATapMutedWhenTapped` proof.

The helper monitors its Electron owner and stable roots of the selected application. It refreshes
descendants because Chromium can replace its Audio Service. A changed process-object set restores
and closes the old tap before a new one may engage. A 64-slot SPSC capture ring reports overflow
instead of silently dropping speech.

### Linux capture contract

The PipeWire helper declares a versioned policy boundary including:

```json
{
  "supportsArming": true,
  "supportsDeferredRoute": true,
  "supportsCaptureProof": true,
  "supportsProcessScopedRouting": true,
  "supportsRollbackProof": true,
  "supportsPrelinkedIngress": true,
  "supportsDynamicProcessStreams": true,
  "supportsCrashRecovery": true,
  "policyVersion": 2,
  "routeOwner": "wireplumber-prelink-policy"
}
```

Ready must identify the exact `chatgpt` or `codex` route and an unmodified armed graph. Engaged
status additionally requires owned ingress capture, capture-link proof, the matching pre-link
policy, and verified bypass mute. Audio without that ownership proof is a protocol fault. The
native helper owns a 64-slot capture queue and reports `suppressionHeld` when bypass restoration is
uncertain.

### Windows capture and route contracts

Windows separates PCM capture from sink membership verification:

- the capture helper declares `backend: "wasapi-process-loopback"`, Windows build 20348 minimum,
  48 kHz stereo `f32le`, process-tree capture/capture proof, and `supportsSuppression: false`;
- the route helper declares `backend: "windows-virtual-endpoint-verifier"`, the verified VB-CABLE
  Input identity, `virtualCableInstalled`, `routeMutation: false`, `manualAssignmentRequired: true`,
  `restoreMechanism: "manual-volume-mixer"`, current-session membership proof, and event-driven
  monitoring whose notifications are not guaranteed to precede first audio.

The route helper emits `armed` only when no selected live session is on the sink and `engaged` when
all applicable current live sessions are on that exact sink. WASAPI PCM is accepted for conversion
only in `engaged`. The separate Windows standby lifecycle can consume the same capture and forward it
through bounded physical-output passthrough while conversion is idle.

## Output control

Electron writes Audio frames to an output helper's stdin. The helper writes Ready, Status, and Error
frames to stdout. Ready must echo the exact prepared `sampleRate`, `channels`, and `f32le` format.

| Platform | Backend and target proof | Current bounds |
| --- | --- | --- |
| macOS | Core Audio output UID, aggregate membership and member-UID verification | ≤40 ms frame, 64 buffers, 500 ms startup/rebuffer target |
| Linux | Native PipeWire target object and whether it follows the default | ≤40 ms frame, 64-frame queue, 500 ms startup/rebuffer target |
| Windows conversion | WASAPI shared-render physical device id/name | ≤80 ms frame, 500 ms startup, 1,500 ms capacity |
| Windows standby | WASAPI shared-render physical device id/name, passthrough mode | ≤80 ms frame, 40 ms startup, 250 ms capacity |

macOS converted-only BlackHole setup additionally requires a non-aggregate default output and
fully verified device membership. Linux can target an explicit PipeWire object or the resolved
default. Windows output refuses VB-CABLE Input as its physical destination.

Status reports the backend's explicit running/rebuffer or terminal failure state. Buffer targets
are configuration values, not measured capture-to-speaker latency.

## Failure and cleanup rules

- Protocol errors are terminal to the active helper session.
- Capture overflow and sequence gaps never trigger source-PCM playback as converted output.
- Output queues are bounded; invalid format, duration, sequence, or body length is rejected.
- Route proof is platform-specific and cannot be synthesized from successful discovery alone.
- A helper failure with unknown restoration reports suppression held/uncertain until ordered cleanup.
- Windows route verification never claims to have reset persistent Volume Mixer policy; explicit
  user restoration may remain required.
- CPV1 has no negotiation beyond its exact version and readiness fields. A breaking change requires
  a new protocol version and matching native/Electron implementations.

See [Architecture](ARCHITECTURE.md) for lifecycle ordering and [Engine contract](ENGINE_CONTRACT.md)
for the separate CPVE sidecar protocol.
