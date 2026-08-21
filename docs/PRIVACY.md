# Privacy

Codex Persona Voice is local-first during active conversion, but “local-first” is not the same as
“no network ever.” This document separates the relay's behavior from setup, external links, and the
source application's own network traffic.

## Summary

- Audio capture, conversion, playback, and optional history run on the local machine.
- Raw source PCM is transported through child-process pipes and is not intentionally written to
  disk or logs.
- Converted history is disabled by default. If enabled, it is stored locally and retained for six
  hours by default.
- Runtime logs are local and do not intentionally include PCM, but can include process paths,
  diagnostics, and child-process errors. The main JSONL log is size-rotated, not time-expired.
- Dependency/model setup uses the network. Inference is configured offline after setup.
- The project includes no analytics, telemetry upload, cloud conversion, account system, or custom
  update service. Packaged builds perform one GitHub Releases update check per launch.

## Data inventory

| Data | Why it exists | Location | Default retention |
| --- | --- | --- | --- |
| Settings and onboarding | Explicit UI language, preferences, and whether the fixed GitHub/X pages were opened | Electron user-data directory | Until changed or user data is removed |
| Source identity/name | Re-find the selected executable/stream | Settings file | Same as settings |
| Window state | Restore bounds/fullscreen/maximized state | Electron user-data directory | Until replaced or removed |
| Logs | Local diagnostics and fault analysis | User-data `logs/launcher.jsonl` plus `.1`–`.3` | 5 MiB current file + three size-rotated archives |
| Fatal log | Last-resort startup error | User-data `launcher-fatal.log` plus `.1` | 512 KiB current file + one size-rotated archive |
| Update worker log | Local detached-update progress/failure | User-data `logs/update-worker.log` plus `.1` | 256 KiB current file + one size-rotated archive |
| Converted history | Optional playback of converted speech | User-data `history/segments/*.wav` | Disabled by default; six hours when enabled |
| History index | Clip metadata and internal filenames | User-data `history/index.json` | Follows history cleanup |
| Model runtime | Python environment, model files, install manifest | Source `runtime/seed-vc/` in development; user-data `engine/seed-vc/` when packaged | Until manually removed or **Remove engine** |
| Voice references | Selected target conditioning samples | Repository/package resources | Shipped with source/artifact |
| Linux audio policy | Managed PipeWire/WirePlumber config plus activation receipt | Per-user XDG config/data/state roots | Until in-app **Remove route…**, `linux-audio-policy.cjs remove --reload`, or account removal |
| Windows per-app output policy | Assignment of ChatGPT/Codex to VB-CABLE Input | Windows Sound/Volume Mixer policy | Until restored by the user/OS |

The default user-data root is Electron's application-data location under `Codex Persona Voice`.
Developers can override it with an absolute `CODEX_PERSONA_VOICE_DATA_DIR` path.

On POSIX-capable systems, the app attempts `0700` directories and `0600` private files. Other
platforms use their filesystem/OS access controls. This is local access minimization, not encrypted
storage.

## Audio handling

### Raw source audio

The platform capture helper sends engaged `f32le` PCM to Electron over stdout using CPV1: a Core
Audio process tap on macOS, an owned PipeWire ingress monitor on Linux, or process-scoped WASAPI
loopback on Windows after the selected live sessions are verified on VB-CABLE Input. Electron
sends exact 300 ms blocks to the Seed-VC worker over CPVE. No raw-audio file or network socket is
part of this path, and logging code records metadata/errors rather than PCM bodies.

The adapter deliberately discards the first three seconds of each newly prepared/reset engine
session. Discarded audio is not eligible for history or output.

### Converted audio

Converted frames are written to the local Core Audio, PipeWire, or WASAPI output helper. “Save
converted audio” is disabled by default. If the user enables it, frames successfully submitted to
the output session can also enter the history recorder. History is PCM16 WAV and contains the
converted voice.

On macOS, if the optional recording bus is enabled, the same converted frames are mirrored to the local
`BlackHole 2ch` device. BlackHole and recording software have their own privacy/security boundary
and are not bundled by this project. Persona Voice rejects recording-bus startup when the default
output (including an aggregate/Multi-Output Device) already contains BlackHole, because that route
would expose unrelated system audio rather than a converted-only stream.

### History controls

- Default: disabled; enabling it starts with six-hour retention.
- Available retention choices: 1, 6, 24, 72, or 168 hours, or no automatic expiry.
- Cleanup runs on startup/retention change and every five minutes while the app is alive.
- Disabling history prevents future writes but does not delete existing clips.
- Clear history deletes indexed WAV files and replaces the index. Normal filesystem recovery,
  backups, snapshots, or recording-software copies may still retain data outside the app.

Do not select “never” for sensitive audio unless you have a separate deletion policy.

## Diagnostics

Logs can include timestamps, platform/version, state transitions, queue duration, suppression state,
process/helper ids, sample metadata, selected device names, errors, stack traces, and a bounded tail
of worker/native stderr. Source discovery/settings can encode or display executable paths.

The main JSONL log rotates when the next record would take it above 5 MiB and retains three numbered
archives. The fallback fatal-startup log separately uses a 512 KiB current-file bound plus one
archive. The detached update worker uses a 256 KiB current-file bound plus one archive. These are
byte bounds, not time-based expiry guarantees. Review diagnostics before
attaching them to an issue, and never post a file containing a sensitive path, process name,
username, or conversation-derived detail without redaction.

## Network behavior

### Setup

The following explicit setup actions use the network:

- `bun install` downloads JavaScript dependencies from configured package registries;
- `uv` may acquire Python 3.11 and downloads locked Python packages;
- `setup:engine` downloads pinned model files through Hugging Face Hub;
- packaged **Install engine** acquires managed Python, locked packages, and the same seven pinned
  model files; cancellation/resume can retain partial downloads in private application data;
- Git submodule initialization downloads the pinned Seed-VC repository;
- on Windows, an explicit setup button opens the official VB-Audio VB-CABLE page in the browser.

Model revisions and expected SHA-256 values are recorded in `engine/seed-vc/model-lock.json`. Python
package versions are pinned in the platform requirements lock. Before model code is imported, each
worker startup rechecks every locked offline artifact's byte size and SHA-256.

### Runtime

The Seed-VC worker sets Hugging Face and Transformers offline flags and disables Hugging Face
telemetry before loading models. The launcher has no analytics/upload client.

In a packaged build, Electron main requests the latest release metadata from
`api.github.com/repos/miuuyy/ChatGPT-Persona-Voice/releases/latest` once per launch. If a newer exact
platform artifact exists, no artifact is downloaded until the user selects Update. The downloaded
artifact and `SHA256SUMS` come from the fixed GitHub release path; the digest is checked before a
detached local worker can install it. Development runs do not check for updates. While the
repository is private, an unauthenticated client receives no usable release metadata; no GitHub
token is stored or sent by Persona Voice.

The first-run UI requires an explicit `en`, `ja`, or `zh-CN` interface-language choice before the
support and engine steps; it does not infer a locale from the OS. The language remains local in the
settings file and can be changed later. The support step optionally opens the fixed repository and
creator X profile after explicit clicks; neither action is required to continue. It stores only
`githubOpened`/`xOpened` booleans and cannot verify a star/follow or read either account.
The UI can also open a voice terms URL, repository URL, or the fixed official VB-CABLE page after an explicit click. The OS browser
then owns those requests.

ChatGPT/Codex voice sessions have their own provider network behavior. Capturing their local output
does not make those source applications offline and does not change their privacy terms.

### Development server

`bun run dev` starts Vite on loopback (`127.0.0.1`). That local HTTP connection is development
tooling, not a remote conversion service.

## OS permissions and discovery

macOS transparent capture uses the Audio Capture permission controlled by TCC; the app does not
bypass that prompt. Linux's in-app setup worker installs only managed per-user PipeWire/WirePlumber
files and restarts the user audio services after explicit user action; unmanaged conflicting files
are not replaced or removed. Windows uses VB-CABLE installed separately from the official VB-Audio
site; Persona Voice does not download, install, update, or remove that driver. Per-app assignment and
restoration are explicit in Volume Mixer. Graceful Quit blocks for restoration confirmation, but a
crash/force-kill can leave the OS-owned preference pointing at the sink. Source discovery enumerates
local process metadata and, on Linux, PipeWire stream metadata.

Grant capture permission only on a machine where every user with access to the local account and
data directory is trusted appropriately.

## Deletion

The app exposes Clear history but not a one-click “delete all data” operation. To remove all project
data:

1. stop and quit the app cleanly;
2. use Clear history first if the UI is available;
3. on Windows, restore ChatGPT/Codex from VB-CABLE Input to **Default** or the physical output
   in Volume Mixer; remove VB-CABLE separately only if it is no longer needed by other software;
4. on Linux, use **Settings → Application → Remove route…** (or
   `node scripts/linux-audio-policy.cjs remove --reload` in development) before deleting the app;
5. use **Settings → Voice → Remove…** for the packaged engine, then remove the dedicated user-data
   directory through the operating system if all settings/logs should also be deleted;
6. developers may separately remove the ignored `runtime/seed-vc/` directory;
7. check backups, snapshots, macOS BlackHole/OBS recordings, and exported artifacts separately.

Confirm the exact directory in Settings → Diagnostics before deleting anything. Do not recursively
delete a broad application-data or home directory.

## Privacy reports

For a suspected privacy/security vulnerability, follow [SECURITY.md](../SECURITY.md) and avoid
posting sensitive audio, logs, paths, or exploit details in a public issue. For ordinary behavior
questions, open a bug report with the smallest redacted diagnostic excerpt needed to reproduce it.
