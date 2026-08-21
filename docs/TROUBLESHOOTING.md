# Troubleshooting

Start with the exact blocker shown in **Settings → Diagnostics**. The relay refuses to start when
its source, route/suppression, engine, or output proof is incomplete.

## Capture a useful report

Before changing anything, record:

- OS version/build, CPU architecture, and GPU/driver;
- source checkout commit;
- Bun and Node versions (`bun --version`, `node --version`);
- source checkout or packaged-artifact run mode;
- selected source and voice;
- runtime state and stable blocker/error code;
- on Linux, PipeWire and WirePlumber versions;
- on Windows, whether VB-CABLE is installed, Windows was restarted afterward, and the app's Volume
  Mixer output assignment;
- the smallest relevant redacted log excerpt and exact failing command.

Do not attach audio or a complete log unless necessary and safe. Logs can contain local paths,
process/device names, and child-process diagnostics.

## Host profile is unsupported

The qualified realtime profiles are:

- `darwin-arm64-mps` on Apple Silicon macOS 14.2+;
- `windows-x64-cuda130` on Windows x64 with NVIDIA CUDA;
- `linux-x64-cuda130` on Linux x64 with NVIDIA CUDA.

Intel macOS, ARM64 Windows/Linux, and CPU-only Windows/Linux have no qualified realtime profile.
Changing a capability result or requirements filename does not create a working profile.

## Dependency installation fails

From the repository root:

```bash
git submodule update --init --recursive
bun install --frozen-lockfile
```

If the frozen install reports a mismatch, verify the checkout and Bun 1.3.14. Do not regenerate
`bun.lock` only to make the error disappear.

## Engine setup is unavailable or invalid

### “Realtime Seed-VC requires Apple Silicon or x64 Windows/Linux with NVIDIA CUDA”

The current OS/architecture has no profile. Use one of the hosts above; there is no CPU fallback.

### NVIDIA CUDA is unavailable

On Windows/Linux, the installer runs a real CUDA tensor operation before downloading models. Verify
that an NVIDIA GPU is visible to the current user and that the installed driver supports the locked
CUDA 13.0 PyTorch profile. Persona Voice does not fall back to CPU or another Torch build.

### `uv` or managed Python 3.11 cannot be created

For source setup, verify `uv --version`, the expected PATH, free space, and network access. Setup
uses a managed Python 3.11 environment and a platform-specific hash lock; a global environment is
not a supported replacement. A packaged app carries pinned `uv` 0.11.14; retry from **Settings →
Voice** and preserve the exact installer error.

### Seed-VC submodule revision mismatch

```bash
git submodule update --init --recursive
git -C engine/vendor/seed-vc rev-parse HEAD
```

The revision must match `seedVcCommit` in `engine/seed-vc/model-lock.json`. Do not move the submodule
without updating the lock, tests, notices, and review evidence.

### Model hash, package lock, or install-manifest mismatch

```bash
bun run setup:engine
```

If a source reinstall is necessary, quit the app, rename only the dedicated `runtime/seed-vc/`
directory as a backup, rerun setup, and delete the backup only after the new runtime verifies. Do
not delete a workspace, home directory, or shared cache.

### Packaged artifact reports a missing engine

Open **Settings → Voice → Install engine**. The minimum free-space checks are 6 GiB on macOS and
15 GiB on Windows/Linux; estimated installed sizes are 2.5, 9, and 11 GiB respectively. Cancellation
leaves resumable staging. Use **Resume** instead of copying a development venv into app data.

**Remove…** deletes the private runtime, staging, managed Python, and installer cache. It does not
delete voices, settings, history, Linux audio policy, or Windows Volume Mixer policy.

## Linux route or policy is not ready

The implemented Linux path requires PipeWire, WirePlumber, native helpers, and the managed pre-link
policy. First use the system-audio card in onboarding or **Settings → Application** to inspect/install
the route. Contributors can inspect the same implementation directly:

```bash
wireplumber --version
pw-dump >/dev/null
node scripts/linux-audio-policy.cjs inspect
```

Install or refresh the per-user policy from the UI, or directly for development:

```bash
node scripts/linux-audio-policy.cjs install --reload
```

This writes only fixed managed files below the user's XDG config/data roots and restarts
`pipewire.service`, `pipewire-pulse.service`, and `wireplumber.service`. An unmanaged file conflict is
intentional: move/reconcile that file yourself instead of bypassing the ownership check. Playback
pauses briefly during the user-session restart, but Persona Voice stays open; no app restart or
system reboot is part of this flow.

The relay is live-proven on Ubuntu 24.04 with WirePlumber 0.4 and Fedora 42 with PipeWire 1.4.11 /
WirePlumber 0.5.14. The Fedora proof covered A/B dynamic streams, per-route mute,
SIGKILL/parent-death restoration, and uninstall cleanup. Include the exact PipeWire/WirePlumber
versions and policy inspection output in a report. Versions outside WirePlumber 0.4/0.5 are
rejected.

Use **Remove route…** in Settings, or remove it directly during development:

```bash
node scripts/linux-audio-policy.cjs remove --reload
```

If the helper reports route restoration unproven, stop the source app and Persona Voice, inspect the
PipeWire graph/session, and do not start another conversion until normal playback and bypass state
are confirmed.

## Windows VB-CABLE route is not ready

### Windows build is too old

Process-scoped WASAPI loopback requires build 20348 or newer. The engine profile does not override
that OS audio requirement.

### VB-CABLE is missing

Persona Voice does not bundle a virtual-audio driver. Choose **Get VB-CABLE** in onboarding or
Settings, download it from the official VB-Audio page, extract the archive, run the x64 setup as
administrator, and restart Windows. Then reopen Persona Voice and choose **Check again**.

The route helper recognizes the base VB-CABLE playback endpoint by the signed driver's stable
endpoint description and adapter properties. Renaming another output to “CABLE Input” does not make
it eligible. Additional CABLE A/B/C/D products are not substituted for the base endpoint.

### Route verifier asks for Volume Mixer assignment

The in-app system-audio screen guides verification, but the verifier observes current live sessions
and does not mutate per-app policy. With Persona Voice stopped:

1. open ChatGPT/Codex and start real voice/audio playback so a live session exists;
2. open **Settings → System → Sound → Volume mixer**;
3. set the selected app's output to **CABLE Input (VB-Audio Virtual Cable)**;
4. return to Persona Voice and choose **Verify route**; bounded standby starts only after live proof;
5. Start swaps standby to conversion; Stop returns to 40 ms/250 ms bounded physical-output standby;
6. before quit/uninstall, restore the app to **Default** or the physical output;
7. in the quit dialog choose **I've restored it** only after the change. **Cancel** and **Open Volume
   Mixer** leave the route owned for recovery.

Windows notifications are not guaranteed to precede the first audio frame. A route-membership loss
or manual-restore request is a real lifecycle boundary, not a cosmetic warning. A crash/force-kill
can leave the OS-owned per-app preference pointing at VB-CABLE Input; verify it manually before
restarting or removing VB-CABLE.

## Native helper does not build or self-test

Run the target-native commands on the target OS:

```bash
bun run build:native
bun run test:native
```

- macOS requires Xcode Command Line Tools and Core Audio frameworks;
- Linux requires a C++20 compiler, `pkg-config`, PipeWire development headers, and a running
  PipeWire session for native self-tests;
- Windows requires MSVC, CMake, and the Windows SDK.

Include the first compiler/helper error, not only the final script exit.

## macOS Audio Capture permission is missing

1. Open **System Settings → Privacy & Security** and review Audio Capture access.
2. Grant access to the development Electron app/terminal or packaged app as appropriate.
3. Quit Persona Voice cleanly and restart it.
4. Run `bun run smoke:capture:mac` only for an intentional live permissioned smoke.

TCC is not bypassed. macOS older than 14.2 cannot use the process-tap route.

## Source application is not found

- Start ChatGPT or Codex before refreshing sources.
- If both are running, explicitly choose one where the platform requires a unique route.
- Re-select an app after its executable identity moves or changes.
- Verify that the source and Persona Voice run in the same user audio session.
- On Linux, check that the selected PipeWire identity maps unambiguously to `chatgpt` or `codex`.

Discovery proves identity only. Readiness additionally requires the platform route, engine, and
output checks.

## Relay stays Armed

Armed/idle behavior is platform-specific:

- macOS observes duplex I/O with no tap attached;
- Linux keeps the owned policy bypass audible and waits to prove ingress capture plus bypass mute;
- Windows may keep bounded standby passthrough after the app is assigned to VB-CABLE Input and
  waits for current live-session membership proof.

Begin a real voice session and wait for assistant audio, not only UI animation. Do not interpret
Armed as converted playback.

## The beginning of a session is silent

Seed-VC intentionally discards the first three seconds after each prepared/reset engine session.
Discarded source audio does not enter output or history. This policy is separate from the native
output prebuffer.

If silence continues, inspect whether the runtime reached Running and whether the platform route,
engine, or output reported a fault.

## Output starts late or reports rebuffering

macOS/Linux output use a 500 ms startup/rebuffer target. Windows converted output also uses a
500 ms startup target with a 1,500 ms bounded queue; Windows standby uses 40 ms startup and a
250 ms capacity. These are configuration bounds, not end-to-end latency promises.

The macOS-only jitter smoke is:

```bash
bun run smoke:output:jitter:mac
```

Report platform, device, underrun state, sample format, and hardware details. Do not make queues
unbounded or substitute original audio to hide starvation.

## Runtime is Faulted or restoration is unproven

Faulted means a processing, route, or cleanup step failed. The runtime can retain explicit route
ownership/uncertainty until cleanup is proven.

1. Use Stop and wait for it to complete.
2. Do not start another relay while Stop reports an error.
3. Follow the Linux topology or Windows manual-restore procedure above when applicable.
4. After successful restoration, quit cleanly and relaunch.
5. If restoration cannot be proved, stop the source voice session/application and inspect the OS
   audio route before retrying.

Never kill only the output or engine helper while capture/suppression remains engaged. Common
terminal causes include sequence gaps, capture overflow, more than 6,000 ms queued source duration,
engine timeout/exit, invalid PCM, output loss/underrun, route-helper exit, and failed restoration.

## macOS OBS / BlackHole recording bus is blocked

The optional macOS bus requires a local device with UID `BlackHole2ch_UID`. Persona Voice mirrors
the same converted frames to the default output and BlackHole only when both prepare successfully.
It rejects aggregate defaults and any default route already containing BlackHole because that could
expose unrelated system audio or duplicate converted audio.

Avoid also recording the original app/system stream when the goal is a converted-only recording.
BlackHole/OBS storage is outside Persona Voice's privacy boundary.

## History is missing or remains on disk

- History records only converted frames submitted to output.
- The first discarded three seconds are never stored.
- Disabling history affects future frames only.
- Clear history removes indexed WAV files; backups/snapshots/recording tools may retain copies.
- Retention cleanup runs every five minutes, not at an exact expiry instant.

See [Privacy](PRIVACY.md) for the complete storage boundary.

## Logs and local data

**Settings → Diagnostics** opens the exact user-data directory. Typical files include:

```text
launcher-state.json
window-state.json
logs/launcher.jsonl
history/index.json
history/segments/*.wav
```

Developers may set `CODEX_PERSONA_VOICE_DATA_DIR` to an absolute dedicated test directory. Never
point it at a broad shared directory.

If the issue can expose sensitive audio, local data, driver/policy state, or route-control behavior,
report it through [Security](../SECURITY.md) rather than a public issue.
