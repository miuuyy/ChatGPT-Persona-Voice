# Model adapters

This document defines the engineering bar for another voice-conversion backend. It is a guide for
repository contributors, not a stable plugin API. Today, adapters are wired in Electron main and
the implemented engines are Seed-VC Tiny (Apple MPS and Windows/Linux x64 NVIDIA CUDA) and
Chatterbox (Apple Silicon MLX). Their fixed model catalog and isolated installers are internal
contracts; see [Voice models](VOICE_MODELS.md).

## Boundary

A model adapter receives validated local `f32le` source frames and returns validated local `f32le`
converted frames. It does not own source discovery, original-route suppression, hardware output,
renderer paths, or history policy.

```text
source/suppression → PipelineRuntime → model adapter → output/history
```

The runtime-facing lifecycle is specified in [Engine contract](ENGINE_CONTRACT.md). A process
worker may use CPVE internally, but the current CPVE format is not yet a published extension API.

## Admission checklist

Before implementation, document:

- model/source license and distribution obligations;
- every downloaded artifact, immutable revision, expected hash, and upstream license;
- supported OS, architecture, accelerator, memory, and runtime versions;
- input/output formats and exact block/lookahead behavior;
- target-voice consent, attribution, reference storage, and deletion model;
- setup, update, rollback, and removal behavior;
- offline inference behavior and every possible network request;
- bounded queue, request, startup, reset, shutdown, and failure behavior;
- an end-to-end benchmark plan that includes the output buffer, not only model inference.

An adapter with unclear redistribution rights, unpinned executable code, unverifiable weights, or a
hidden network dependency is not eligible for a ready state.

## Required runtime behavior

### Probe

Return a truthful, stable readiness result. Probe must verify the selected profile, target voice,
runtime executable, install manifest, model files, and hardware capability. It must not download,
repair, select another model, or return an identity converter behind the user's back.

### Prepare

Prepare receives the source's exact format and must finish expensive load/conditioning/warmup before
route engagement. A model that can cool while armed may expose a bounded `prime` hook that runs
after engagement and before output opens. Return an immutable output format and a session
implementing `convert`, `reset`, and `close`.

If an adapter needs resampling or channel mapping, that behavior belongs inside the declared
adapter profile and its tests. Do not let the runtime infer or guess a format.

### Convert

- Validate every input frame and preserve ordering.
- Bound pending input by duration and worker messages by bytes.
- Return zero or more ordered frames no longer than the runtime maximum.
- Surface format changes, NaN/Inf data, timeouts, worker exits, and output-shape errors as terminal.
- Never substitute source PCM, cached prior output, or a lower-quality hidden model on failure.

### Reset and close

Reset must cancel or epoch-fence in-flight results, clear accumulated audio and model streaming
state, and acknowledge only after quiescence. Close must be idempotent. If reset cannot be proven,
confirmed worker termination is preferable to reusing contaminated state.

## Worker isolation

A separate process is preferred when an engine:

- uses a license boundary such as GPL code;
- depends on Python/native packages outside Electron;
- holds substantial accelerator memory;
- can crash or hang independently;
- benefits from a protocol-level timeout and termination boundary.

For CPVE workers, preserve the existing byte/header limits and request correlation. Do not parse
stdout as mixed logs and protocol: protocol frames belong on stdout, diagnostics on stderr.

## Installation contract

Model installation must be explicit and reproducible:

1. select an exact adapter/profile;
2. show disk/network/license implications before download;
3. install into an adapter-owned directory with private permissions where possible;
4. verify hashes before publishing the install manifest;
5. make the manifest the readiness authority;
6. keep the previous valid installation until the new one is proven, if updates are supported;
7. support deterministic removal without deleting unrelated user data.

The Seed-VC and Chatterbox adapters implement this contract in source and packaged engine
installer for each qualified host profile.
New adapters must preserve the same explicit network/license disclosure, resumable staging,
verification-before-publication, interrupted-publication recovery, and scoped removal behavior.

## Voice catalog rules

Renderer input may select only an opaque catalog id. Main-process code resolves the reference path
after validating:

- a stable id and display metadata;
- a repository-contained or adapter-owned reference location;
- expected file type/size/hash;
- terms URL and required credit;
- consent/authorization evidence appropriate to the contribution.

Arbitrary renderer-supplied model or voice paths are out of scope. Do not add celebrity, private,
or scraped voices without explicit, reviewable authorization.

## Conformance tests

A new adapter should have deterministic tests for:

- unavailable/missing/corrupt/wrong-platform readiness;
- exact format preparation and changed-format rejection;
- byte-aligned input and bounded output frames;
- ordering and sequence wrap behavior;
- silence and non-finite PCM;
- queue overflow and conversion timeout;
- reset during in-flight conversion and stale-result fencing;
- worker protocol corruption, stderr flood bounds, crash, and unresponsive shutdown;
- repeated prepare/reset/close without state leakage;
- manifest/hash/license metadata changes;
- no identity or hidden fallback under every injected failure.

Opt-in quality or hardware benchmarks supplement these contract tests; they do not replace them.

## Review artifacts

A model-adapter pull request must include:

- an architecture/contract update;
- install lock and generated manifest schema;
- third-party notices and license delivery plan;
- unit/conformance tests plus exact local commands/results;
- representative resource measurements on named hardware;
- privacy changes and all network endpoints;
- release-matrix changes that keep unqualified hosts blocked.

The future packaging surface is described in [Engine SDK plan](ENGINE_SDK.md).
