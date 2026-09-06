(() => {
  const snapshotListeners = new Set();
  const runtimeListeners = new Set();
  const updateListeners = new Set();
  const state = {
    app: { name: "Codex Persona Voice", version: "0.1.0", platform: "darwin", packaged: true },
    onboarding: { complete: true, githubOpened: true, xOpened: true },
    update: { status: "up-to-date" },
    settings: {
      uiLocale: "en",
      selectedModelId: "seed-vc",
      windowsManualRouteConfigured: false,
      sourceMode: "desktop-application",
      sourceId: null,
      sourceName: null,
      selectedVoiceId: "voicevox-shikoku-metan-normal",
      selectedVoiceName: "Shikoku Metan",
      retentionHours: 6,
      saveConvertedAudio: true,
      recordingBusEnabled: false,
      launchAtLogin: false,
      keepRunningOnClose: true,
    },
    autostart: { supported: true, enabled: false },
    capabilities: {
      platform: "darwin",
      release: "25.6.0",
      macVersion: "26.0",
      codex: { detected: true, executable: "/opt/homebrew/bin/codex", detail: "Codex CLI found at /opt/homebrew/bin/codex" },
      ownedSession: { possible: true, ready: false, code: "codex_app_server_bridge_missing", detail: "The App Server realtime bridge is specified but not bundled in this milestone" },
      desktopCapture: { possible: true, ready: true, code: "ready", detail: "Native Core Audio PCM capture helper is built" },
      suppression: { possible: true, ready: true, code: "ready", detail: "Capture helper uses CATapMutedWhenTapped to suppress original playback" },
      engine: { ready: true, code: "ready", detail: "Seed-VC tiny · 10 steps · Apple MPS" },
      output: { ready: true, code: "ready", detail: "Native bounded Core Audio output helper is built" },
    },
    runtime: {
      state: "stopped",
      error: null,
      startedAt: null,
      suppressionHeld: false,
      suppressionUncertain: false,
      queuedAudioMs: 0,
      ready: true,
      checks: [
        { id: "source", label: "Audio source", ready: true, code: "ready", detail: "Automatic ChatGPT/Codex process tree is ready for muted capture" },
        { id: "suppression", label: "Original suppression", ready: true, code: "ready", detail: "Muted Core Audio tap is built and the selected process tree is available" },
        { id: "engine", label: "Voice engine", ready: true, code: "ready", detail: "Shikoku Metan · Seed-VC tiny · 10 steps · Apple MPS" },
        { id: "output", label: "Converted output", ready: true, code: "ready", detail: "Core Audio output helper and default device passed self-test" },
      ],
    },
    platformAudioSetup: { status: "ready", code: "not_required", detail: "No additional system route required on macOS", canInstall: false, canActivate: false, canRemove: false, requiresRouteAssignment: false },
    engineInstallation: {
      status: "ready",
      detail: "The locked Seed-VC engine package is installed",
      installedBytes: 2684354560,
      estimatedInstalledBytes: 2684354560,
      minimumFreeBytes: 6442450944,
    },
    engineDiagnostics: {
      profile: "seed-vc-tiny-realtime",
      workerState: "ready",
      active: false,
      voiceId: "voicevox-shikoku-metan-normal",
      steps: 10,
      blockMs: 300,
      startupDiscardMs: 3000,
      convertedBlocks: 12,
      loadSeconds: 2.19,
      warmupSeconds: 1,
      torch: "2.13.0",
      lastInferenceMs: 155.82,
      mpsCurrentAllocatedBytes: 1034666240,
      mpsDriverAllocatedBytes: 1350860800,
      mpsRecommendedMaxBytes: 19069665280,
    },
    voices: [
      { id: "voicevox-shikoku-metan-normal", name: "Shikoku Metan", nativeName: "四国めたん", description: "Clear, poised anime voice", locale: "ja-JP", requiredCredit: "VOICEVOX:四国めたん", termsUrl: "https://zunko.jp/con_ongen_kiyaku.html", referenceBytes: 138244, referenceSha256: "a".repeat(64) },
      { id: "voicevox-zundamon-normal", name: "Zundamon", nativeName: "ずんだもん", description: "Bright, childlike high voice", locale: "ja-JP", requiredCredit: "VOICEVOX:ずんだもん", termsUrl: "https://zunko.jp/con_ongen_kiyaku.html", referenceBytes: 142916, referenceSha256: "b".repeat(64) },
      { id: "voicevox-kasukabe-tsumugi-normal", name: "Kasukabe Tsumugi", nativeName: "春日部つむぎ", description: "Energetic, cheerful voice", locale: "ja-JP", requiredCredit: "VOICEVOX:春日部つむぎ", termsUrl: "https://tsumugi-official.studio.site/rule", referenceBytes: 136724, referenceSha256: "c".repeat(64) },
    ],
    history: [
      { id: "11111111-1111-4111-8111-111111111111", createdAt: "2026-08-08T09:42:00.000Z", durationMs: 18400, bytes: 883244, voiceName: "Studio warm", sourceName: "Codex realtime", fileName: "11111111-1111-4111-8111-111111111111.wav" },
      { id: "22222222-2222-4222-8222-222222222222", createdAt: "2026-08-08T09:16:00.000Z", durationMs: 7200, bytes: 345644, voiceName: "Studio warm", sourceName: "Codex realtime", fileName: "22222222-2222-4222-8222-222222222222.wav" },
    ],
  };

  state.models = [
    { id: "seed-vc", name: "Seed-VC Tiny", releaseYear: 2024, blockMs: 300, supported: true, recommended: false, installation: state.engineInstallation },
    { id: "chatterbox", name: "Chatterbox", releaseYear: 2025, blockMs: 640, supported: true, recommended: true,
      installation: { status: "idle", detail: "Model download required", estimatedInstalledBytes: 4 * 1024 ** 3, minimumFreeBytes: 8 * 1024 ** 3, resumable: false } },
  ];

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const publish = () => snapshotListeners.forEach((listener) => listener(clone(state)));
  window.codexPersonaVoice = {
    snapshot: async () => clone(state),
    openSocial: async (target) => { state.onboarding[target === "github" ? "githubOpened" : "xOpened"] = true; publish(); return clone(state.onboarding); },
    completeOnboarding: async () => { state.onboarding.complete = true; publish(); return clone(state.onboarding); },
    refreshReadiness: async () => clone(state.runtime),
    installEngine: async () => clone(state.engineInstallation),
    cancelEngineInstall: async () => false,
    removeEngine: async () => clone(state.engineInstallation),
    setSetting: async (key, value) => { state.settings[key] = value; publish(); return clone(state.settings); },
    setAutostart: async (enabled) => { state.settings.launchAtLogin = enabled; state.autostart.enabled = enabled; publish(); return clone(state.autostart); },
    selectSource: async (source) => { state.settings.sourceId = source?.id ?? null; state.settings.sourceName = source?.name ?? null; publish(); return clone(state.settings); },
    selectSourceMode: async (mode) => { state.settings.sourceMode = mode; publish(); return clone(state.settings); },
    selectModel: async (id) => {
      const model = state.models.find(candidate => candidate.id === id);
      if (!model?.supported) throw new Error("Unsupported model");
      state.settings.selectedModelId = id;
      state.engineInstallation = model.installation;
      publish();
      return clone(state.settings);
    },
    selectVoice: async (id) => { const voice = state.voices.find((candidate) => candidate.id === id); state.settings.selectedVoiceId = voice.id; state.settings.selectedVoiceName = voice.name; publish(); return clone(state.settings); },
    voiceSample: async (id) => ({ voice: clone(state.voices.find((candidate) => candidate.id === id)), data: new Uint8Array(), mimeType: "audio/wav" }),
    openVoiceTerms: async () => true,
    listSources: async () => ({ platform: "darwin", sources: [
      { id: "process:darwin:Y2hhdGdwdA", name: "ChatGPT", detail: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT", platform: "darwin" },
      { id: "process:darwin:Y29kZXg", name: "Codex", detail: "/Applications/Codex.app/Contents/MacOS/Codex", platform: "darwin" },
    ] }),
    start: async () => { throw new Error("Pipeline is blocked"); },
    stop: async () => clone(state.runtime),
    historyAudio: async () => ({ entry: state.history[0], data: new Uint8Array(), mimeType: "audio/wav" }),
    clearHistory: async () => { const removed = state.history.length; state.history = []; publish(); return { removed, entries: [] }; },
    openDataDirectory: async () => true,
    openRepository: async () => true,
    installUpdate: async () => true,
    windowState: async () => ({ fullScreen: false, maximized: false }),
    windowControl: () => {},
    onSnapshot: (listener) => { snapshotListeners.add(listener); return () => snapshotListeners.delete(listener); },
    onRuntime: (listener) => { runtimeListeners.add(listener); return () => runtimeListeners.delete(listener); },
    onUpdateState: (listener) => { updateListeners.add(listener); return () => updateListeners.delete(listener); },
    onWindowState: () => () => {},
  };
})();
