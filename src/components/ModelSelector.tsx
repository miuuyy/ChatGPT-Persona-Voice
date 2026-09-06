import { formatMessage, useI18n } from "../i18n";
import type { LauncherSnapshot, VoiceModelId } from "../types";

export function ModelSelector({ snapshot, busy, onSelect, context = "settings" }: {
  snapshot: LauncherSnapshot;
  busy: boolean;
  onSelect: (id: VoiceModelId) => void;
  context?: "settings" | "onboarding";
}) {
  const { messages } = useI18n();
  const copy = messages.models;
  const locked = busy || snapshot.runtime.state !== "stopped" ||
    snapshot.models.some((model) => ["installing", "removing"].includes(model.installation.status));
  return (
    <fieldset className="model-selector" disabled={locked}>
      <legend className={context === "onboarding" ? "sr-only" : undefined}>{copy.title}</legend>
      <p className="model-selector-help">{context === "onboarding" ? copy.onboardingHint : copy.switchHint}</p>
      <div className="model-options">
        {snapshot.models.map((model) => (
          <label className={`model-option${snapshot.settings.selectedModelId === model.id ? " is-selected" : ""}${!model.supported ? " is-unavailable" : ""}`} key={model.id}>
            <input aria-label={model.name} aria-describedby={`model-description-${model.id}`}
              checked={snapshot.settings.selectedModelId === model.id} disabled={!model.supported}
              name="voice-model" onChange={() => onSelect(model.id)} type="radio" value={model.id} />
            <span className="model-option-heading">
              <strong>{model.name}</strong>
              {model.recommended ? <span className="model-recommendation">{copy.recommended}</span> : null}
            </span>
            <span className="model-year">{formatMessage(copy.released, { year: model.releaseYear })}</span>
            <span className="model-description" id={`model-description-${model.id}`}>
              {model.id === "seed-vc" ? copy.tinyDescription : copy.chatterboxDescription}
            </span>
            <span className="model-performance">{model.id === "seed-vc" ? copy.tinyPerformance : copy.chatterboxPerformance}</span>
            <span className="model-option-footer">
              <span>{!model.supported ? copy.appleSiliconOnly
                : model.installation.status === "ready" ? copy.installed
                : model.installation.status === "installing" ? copy.installing
                : model.installation.status === "removing" ? messages.settings.voice.removing
                : copy.needsInstall}</span>
              {snapshot.settings.selectedModelId === model.id ? <span className="model-selected-label">{copy.selected}</span> : null}
            </span>
          </label>
        ))}
      </div>
      <p className="model-performance-note">{copy.performanceNote}</p>
    </fieldset>
  );
}
