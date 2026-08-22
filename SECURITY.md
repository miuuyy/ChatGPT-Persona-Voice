# Security policy

Codex Persona Voice is experimental software that controls local audio routes and executes a local
model worker. There is no production-supported release or security-response SLA.

## Supported versions

| Version | Security status |
| --- | --- |
| `main` development tree | Cross-platform source-relay reports/fixes accepted; not production-supported |
| Local packaged artifacts | Unsupported |
| Windows `v0.1.2` preview | VB-CABLE prerequisite; not production-supported |

Security fixes normally target the current development tree. Backports are not promised.

## Report a vulnerability

Use GitHub's private **Report a vulnerability** flow for this repository:

<https://github.com/miuuyy/ChatGPT-Persona-Voice/security/advisories/new>

If that flow is unavailable, open a public issue that asks the maintainer to establish private
contact, but do not include vulnerability details, exploit code, sensitive logs, local paths, or
audio.

Include when possible:

- affected commit/version, OS, architecture, and run mode;
- concise impact and threat model;
- reproducible steps or a minimal proof of concept;
- whether source suppression, permissions, IPC, filesystem paths, model installation, or history is
  involved;
- suggested mitigation, if known;
- whether you plan to coordinate disclosure.

Do not access another person's audio, account, machine, files, or credentials while testing. Use an
isolated local environment and authorized source/target voices.

## High-priority areas

Private reporting is especially appropriate for:

- original-audio leakage while the runtime claims Running;
- route suppression that cannot be safely released after Stop/crash/uninstall;
- renderer-to-main IPC escape, navigation bypass, or sandbox escape;
- arbitrary file read/write/delete through history, settings, voices, or engine paths;
- command/argument/environment injection into native or Python child processes;
- model/package supply-chain substitution or manifest/hash bypass;
- release-asset substitution, updater worker escape, or unsafe application replacement;
- unexpected network transmission of PCM, history, diagnostics, or local identifiers;
- permission/TCC, Linux policy, or Windows VB-CABLE/route bypass and misleading readiness state;
- sensitive audio/history exposure across local users;
- unbounded queues or files that can cause reliable resource exhaustion.

Ordinary setup failures, documented platform qualification blockers, model quality, latency
variation, and UI bugs can use the public issue templates unless they expose sensitive data or a
security boundary.

## Disclosure process

The maintainer will evaluate scope and coordinate a fix/disclosure when possible. Because this is an
experimental volunteer project, no acknowledgement or remediation deadline is guaranteed. Please
avoid public disclosure until the report can be assessed and users can be given a practical
mitigation.

## Security boundaries and limitations

- Local-first inference does not make ChatGPT/Codex source sessions offline.
- Application data is access-restricted where supported but is not encrypted by the app.
- Logs may contain diagnostic paths/errors. The main JSONL log has bounded size rotation; the
  fatal-startup log is capped at 512 KiB plus one archive. Neither has automatic time-based expiry.
- `setup:engine` and dependency installation use the network; runtime inference is configured
  offline after setup.
- Packaged builds query the fixed public GitHub Releases endpoint once per launch. Update downloads
  are restricted to the exact repository/tag/asset path and require an Ed25519-valid
  `SHA256SUMS.sig` plus the matching signed digest before a detached worker runs. Persona Voice
  never embeds a token for private releases.
- No signed/notarized public installer currently exists.
- Experimental packages disable Electron Run-as-Node, `NODE_OPTIONS`, CLI inspection, and
  non-ASAR application loading; they also enable embedded ASAR integrity validation where Electron
  supports it. A packaged process also ignores `VITE_DEV_SERVER_URL`; only an unpackaged
  development run accepts the exact loopback renderer URL `http://127.0.0.1:4178`. These controls
  do not make the artifacts supported releases.
- The development Seed-VC worker uses the exact venv interpreter in Python isolated mode and strips
  inherited Python path/home, user-site, MPS fallback, and dynamic-loader injection variables. This
  narrows environment-based module substitution but does not replace clean-install provenance.
- A passing cross-platform CI job proves non-permissioned build/protocol contracts only. It does not
  establish live route recovery, a clean Windows VB-CABLE lifecycle, Linux policy lifecycle,
  CUDA behavior, or a secure supported release.

See [Privacy](docs/PRIVACY.md), [Architecture](docs/ARCHITECTURE.md), and
[Release engineering](docs/RELEASE.md).
