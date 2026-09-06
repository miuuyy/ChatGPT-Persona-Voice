# Engine SDK plan

Status: design plan only. The repository does not ship an SDK, registry, dynamic adapter loader, or
compatibility guarantee for third-party engines.

The launcher offers two built-in models: Seed-VC Tiny and streaming Chatterbox (Apple Silicon).
Selection and separate installation use fixed application-owned adapters. This does not qualify
the proposed third-party SDK.

## Goal

A future SDK should let a separately maintained local conversion engine integrate without gaining
authority over source suppression, renderer IPC, output routing, or arbitrary user files. The
launcher remains the policy owner; the engine remains a bounded PCM transformer.

## Starting point: CPVE v1 behavior

The current Seed-VC worker already supplies a useful internal boundary:

```text
12-byte prefix:
  "CPVE" | uint32le JSON bytes | uint32le body bytes

limits:
  JSON header 1..65536 bytes
  optional body 0..4 MiB
```

The worker emits `status`, then one `ready`, accepts correlated `prime`, `convert`, `reset`, and `shutdown`
commands, and returns `result`, acknowledgements, or `error`. Ready contains
`protocolVersion: 1`; the binary prefix itself has no negotiated version field.

That behavior is documented in [Engine contract](ENGINE_CONTRACT.md), but is coupled to the
in-tree adapter and is not stable enough to call an SDK.

## Proposed SDK surface

### 1. Versioned manifest

Each engine package would declare immutable metadata rather than relying on executable-name or model
heuristics:

```json
{
  "schemaVersion": 1,
  "id": "org.example.engine",
  "protocol": { "name": "CPVE", "major": 1, "minor": 0 },
  "entrypoint": "bin/engine",
  "profiles": [
    {
      "id": "local-profile",
      "platforms": [{ "os": "darwin", "arch": "arm64" }],
      "input": { "sampleFormat": "f32le", "channels": [1, 2] },
      "output": { "sampleRate": 24000, "channels": 1, "sampleFormat": "f32le" }
    }
  ]
}
```

This is illustrative, not an accepted schema. A real schema must also express bounded block sizes,
lookahead, installer provenance, license inventory, resource requirements, and network policy.

### 2. Launcher-owned process runner

The launcher would:

- resolve an installed manifest from an engine-owned root;
- verify executable and model hashes;
- provide only approved arguments/environment variables;
- connect anonymous child stdin/stdout/stderr pipes;
- enforce CPVE byte/time bounds and a bounded stderr tail;
- terminate the process tree on protocol, timeout, or lifecycle failure;
- keep renderer values away from executable/model paths.

Engines would not receive Electron IPC access, source process ids unless explicitly required by a
future contract, output-device access, history paths, or network credentials.

### 3. Capability negotiation

Negotiation should be explicit and model-authored:

- CPVE major/minor version;
- accepted input rate/channel/format ranges;
- exact output format;
- preferred/min/max input block duration;
- maximum algorithmic lookahead and output frame duration;
- reset and interruption semantics;
- whether inference is guaranteed offline;
- deterministic profile/voice identity.

Unknown required capabilities fail closed. No keyword router, compatibility table, or automatic
profile downgrade should override the engine's declared contract.

### 4. Conformance kit

The SDK would ship a reference host and black-box suite for:

- framing fragmentation/coalescing and size limits;
- invalid JSON, unknown message, duplicate Ready, and id mismatch;
- PCM shape, format, NaN/Inf, and frame-duration validation;
- ordered convert requests and bounded backpressure;
- timeout, crash, stderr flood, and truncated-frame handling;
- reset quiescence and stale-result rejection;
- shutdown acknowledgement/process exit;
- proof that every failure produces no identity/pass-through output.

Passing protocol conformance would not qualify model quality, licensing, installer safety, platform
route ownership, or end-to-end latency.

## Packaging and trust

An engine SDK must not become an unsigned arbitrary-code plugin directory. A release design needs:

- authenticated package provenance and exact hashes;
- platform signing/notarization requirements where applicable;
- license and source-offer delivery for copyleft components;
- explicit install/update/remove UX with disk/network disclosure;
- a per-engine private data root;
- rollback to a previously verified package without hidden profile substitution;
- revocation policy for compromised packages;
- no execution until the manifest and package are verified.

The launcher can support developer-mode adapters from explicit paths later, but they must be labeled
unsafe/development-only and cannot silently become release readiness.

## Stabilization sequence

1. Extract JSON Schemas and golden CPVE vectors from the existing Seed-VC tests.
2. Add an engine-agnostic child-process runner behind the current internal adapter contract.
3. Build a fake reference engine for cross-platform conformance tests.
4. Define major/minor compatibility and rejection behavior.
5. Specify installation manifest, provenance, permissions, and removal.
6. Migrate Seed-VC without changing observable behavior.
7. Qualify a second independently implemented engine to expose contract assumptions.
8. Only then publish an SDK version and support policy.

Until those steps are complete, contributors should follow [Model adapters](MODEL_ADAPTERS.md) and
treat CPVE changes as coordinated in-repository changes.
