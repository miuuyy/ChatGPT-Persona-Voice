import type { UiLocale } from "./i18n";

export type TabId = "home" | "history" | "settings";
export type SourceMode = "codex-app-server" | "desktop-application";
export type RuntimeState = "stopped" | "starting" | "armed" | "engaging" | "running" | "stopping" | "faulted";

export interface OnboardingState {
  complete: boolean;
  githubOpened: boolean;
  xOpened: boolean;
}

export type UpdateState =
  | { status: "disabled" | "idle" | "checking" | "up-to-date" }
  | { status: "available" | "downloading" | "installing"; version: string }
  | { status: "error"; message: string };

export interface Settings {
  uiLocale: UiLocale | null;
  sourceMode: SourceMode;
  sourceId: string | null;
  sourceName: string | null;
  selectedVoiceId: string | null;
  selectedVoiceName: string | null;
  retentionHours: 1 | 6 | 24 | 72 | 168 | null;
  saveConvertedAudio: boolean;
  recordingBusEnabled: boolean;
  launchAtLogin: boolean;
  keepRunningOnClose: boolean;
  windowsManualRouteConfigured: boolean;
}

export type UserSettingKey = Exclude<
  keyof Settings,
  "windowsManualRouteConfigured"
>;

export interface ReadinessCheck {
  id: "source" | "suppression" | "engine" | "output";
  label: string;
  ready: boolean;
  code: string;
  detail: string;
}

export interface RuntimeSnapshot {
  state: RuntimeState;
  error: string | null;
  startedAt: string | null;
  suppressionHeld: boolean;
  suppressionUncertain: boolean;
  queuedAudioMs: number;
  checks: ReadinessCheck[];
  ready: boolean;
}

export interface EngineDiagnostics {
  profile: "seed-vc-tiny-realtime";
  runtimeProfile: string | null;
  device: "mps" | "cuda" | null;
  backend: string | null;
  workerState: "stopped" | "loading" | "ready";
  active: boolean;
  voiceId: string | null;
  steps: number;
  blockMs: number;
  startupDiscardMs: number;
  convertedBlocks: number;
  loadSeconds: number | null;
  warmupSeconds: number | null;
  torch: string | null;
  lastInferenceMs: number | null;
  mpsCurrentAllocatedBytes: number | null;
  mpsDriverAllocatedBytes: number | null;
  mpsRecommendedMaxBytes: number | null;
  cudaAllocatedBytes: number | null;
  cudaReservedBytes: number | null;
  cudaDeviceName: string | null;
}

export type EngineInstallationState =
  | {
      status: "unavailable" | "idle" | "removing";
      detail: string;
      estimatedInstalledBytes: number;
      minimumFreeBytes: number;
      resumable?: boolean;
    }
  | {
      status: "installing";
      phase: "preparing" | "python" | "packages" | "hardware" | "models" | "verifying" | "publishing";
      progress: number;
      detail: string;
      cancellable: boolean;
      estimatedInstalledBytes: number;
      minimumFreeBytes: number;
    }
  | {
      status: "ready";
      detail: string;
      installedBytes: number;
      estimatedInstalledBytes: number;
      minimumFreeBytes: number;
    }
  | {
      status: "error";
      detail: string;
      resumable: boolean;
      estimatedInstalledBytes: number;
      minimumFreeBytes: number;
    };

export type PlatformAudioSetupStatus =
  | "ready"
  | "action-required"
  | "installing"
  | "error"
  | "unavailable";

export interface PlatformAudioSetupState {
  status: PlatformAudioSetupStatus;
  code: string;
  detail: string;
  canInstall: boolean;
  canActivate: boolean;
  requiresRouteAssignment: boolean;
  canRemove: boolean;
}

export interface HistoryEntry {
  id: string;
  createdAt: string;
  durationMs: number;
  bytes: number;
  voiceName: string;
  sourceName: string;
  fileName: string;
}

export interface Capability {
  ready: boolean;
  possible?: boolean;
  code: string;
  detail: string;
}

export interface PlatformCapabilities {
  platform: string;
  release: string;
  macVersion?: string | null;
  windowsBuild?: number | null;
  pipeWireTools?: Record<string, string | null>;
  codex: {
    detected: boolean;
    executable: string | null;
    detail: string;
  };
  ownedSession: Capability;
  desktopCapture: Capability;
  suppression: Capability;
  engine: Capability;
  output: Capability;
}

export interface LauncherSnapshot {
  app: {
    name: string;
    version: string;
    platform: string;
    packaged: boolean;
  };
  onboarding: OnboardingState;
  update: UpdateState;
  settings: Settings;
  autostart: { supported: boolean; enabled: boolean };
  capabilities: PlatformCapabilities;
  runtime: RuntimeSnapshot;
  platformAudioSetup: PlatformAudioSetupState;
  engineInstallation: EngineInstallationState;
  engineDiagnostics: EngineDiagnostics;
  voices: VoicePreset[];
  history: HistoryEntry[];
}

export interface VoicePreset {
  id: string;
  name: string;
  nativeName: string;
  description: string;
  locale: string;
  requiredCredit: string;
  termsUrl: string;
  referenceBytes: number;
  referenceSha256: string;
}

export interface AudioSource {
  id: string;
  name: string;
  detail: string;
  platform: string;
}

export interface VoiceBridge {
  snapshot(): Promise<LauncherSnapshot>;
  openSocial(target: "github" | "x"): Promise<OnboardingState>;
  completeOnboarding(): Promise<OnboardingState>;
  refreshReadiness(): Promise<RuntimeSnapshot>;
  refreshPlatformAudioSetup(): Promise<PlatformAudioSetupState>;
  openWindowsAudioSetupDownload(): Promise<boolean>;
  installPlatformAudioSetup(): Promise<PlatformAudioSetupState>;
  activatePlatformAudioSetup(): Promise<PlatformAudioSetupState>;
  removePlatformAudioSetup(): Promise<PlatformAudioSetupState>;
  installEngine(): Promise<EngineInstallationState>;
  cancelEngineInstall(): Promise<boolean>;
  removeEngine(): Promise<EngineInstallationState>;
  setSetting<Key extends UserSettingKey>(
    key: Key,
    value: Settings[Key],
  ): Promise<Settings>;
  setAutostart(enabled: boolean): Promise<{ supported: boolean; enabled: boolean }>;
  selectSource(source: Pick<AudioSource, "id" | "name"> | null): Promise<Settings>;
  selectSourceMode(mode: SourceMode): Promise<Settings>;
  selectVoice(id: string): Promise<Settings>;
  voiceSample(id: string): Promise<{ voice: VoicePreset; data: Uint8Array; mimeType: string }>;
  openVoiceTerms(id: string): Promise<boolean>;
  listSources(): Promise<{ platform: string; sources: AudioSource[] }>;
  start(): Promise<RuntimeSnapshot>;
  stop(): Promise<RuntimeSnapshot>;
  historyAudio(id: string): Promise<{ entry: HistoryEntry; data: Uint8Array; mimeType: string }>;
  clearHistory(): Promise<{ removed: number; entries: HistoryEntry[] }>;
  openDataDirectory(): Promise<boolean>;
  openRepository(): Promise<boolean>;
  installUpdate(): Promise<boolean>;
  windowState(): Promise<{ fullScreen: boolean; maximized: boolean }>;
  windowControl(action: "close" | "minimize" | "zoom"): void;
  onSnapshot(listener: (snapshot: LauncherSnapshot) => void): () => void;
  onRuntime(listener: (runtime: RuntimeSnapshot) => void): () => void;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
  onWindowState(listener: (state: { fullScreen: boolean; maximized: boolean }) => void): () => void;
}

declare global {
  interface Window {
    codexPersonaVoice?: VoiceBridge;
  }
}
