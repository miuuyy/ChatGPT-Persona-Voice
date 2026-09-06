import { useState } from "react";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { settingsSections, type SettingsSectionId } from "../lib/presentation";
import {
  SettingsSections,
  type SettingsSectionProps,
} from "./settings/SettingsSections";

export function SettingsPage({
  snapshot,
  section,
  busy,
  sources,
  sourceLoading,
  playingKey,
  onSection,
  onSetting,
  onAutostart,
  onInstallEngine,
  onCancelEngineInstall,
  onRemoveEngine,
  onMode,
  onDiscoverSources,
  onSelectSource,
  onSelectVoice,
  onSelectModel,
  onPreviewVoice,
  onVoiceTerms,
  onRequestClear,
  onOpenData,
  onOpenRepository,
}: SettingsSectionProps & {
  onSection: (section: SettingsSectionId) => void;
}) {
  const { messages } = useI18n();
  const [query, setQuery] = useState("");
  const sections = settingsSections(messages);
  const activeSection =
    sections.find((candidate) => candidate.id === section) || sections[0];
  const normalizedQuery = query.trim().toLowerCase();
  const searchResults = normalizedQuery
    ? sections.filter((candidate) =>
        `${candidate.label} ${candidate.description} ${candidate.keywords}`
          .toLowerCase()
          .includes(normalizedQuery),
      )
    : [];

  function selectSearchResult(id: SettingsSectionId) {
    onSection(id);
    setQuery("");
  }

  return (
    <section className="content-surface settings-surface">
      <div className="settings-shell">
        <aside aria-label={messages.settings.navigation} className="settings-navigation">
          <label className="settings-search">
            <Icon name="search" />
            <input
              aria-label={messages.settings.searchLabel}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={messages.settings.searchPlaceholder}
              type="search"
              value={query}
            />
          </label>
          {normalizedQuery ? (
            <div className="settings-search-results">
              <span>{messages.settings.results}</span>
              {searchResults.length > 0 ? (
                searchResults.map((candidate) => (
                  <button
                    key={candidate.id}
                    onClick={() => selectSearchResult(candidate.id)}
                    type="button"
                  >
                    <Icon name={candidate.icon} />
                    <span>
                      <strong>{candidate.label}</strong>
                      <small>{candidate.description}</small>
                    </span>
                    <Icon name="chevron" />
                  </button>
                ))
              ) : (
                <p>{messages.settings.noResults}</p>
              )}
            </div>
          ) : (
            <nav>
              {sections.map((candidate) => (
                <button
                  aria-current={candidate.id === section ? "page" : undefined}
                  className={candidate.id === section ? "is-active" : ""}
                  key={candidate.id}
                  onClick={() => onSection(candidate.id)}
                  type="button"
                >
                  <Icon name={candidate.icon} />
                  <span>{candidate.label}</span>
                </button>
              ))}
            </nav>
          )}
        </aside>
        <div className="settings-panel-scroll">
          <header className="settings-header">
            <h1>{activeSection.label}</h1>
            <p>{activeSection.description}</p>
          </header>
          <SettingsSections
            busy={busy}
            onAutostart={onAutostart}
            onCancelEngineInstall={onCancelEngineInstall}
            onDiscoverSources={onDiscoverSources}
            onMode={onMode}
            onInstallEngine={onInstallEngine}
            onOpenData={onOpenData}
            onOpenRepository={onOpenRepository}
            onPreviewVoice={onPreviewVoice}
            onRequestClear={onRequestClear}
            onRemoveEngine={onRemoveEngine}
            onSelectSource={onSelectSource}
            onSelectVoice={onSelectVoice}
            onSelectModel={onSelectModel}
            onSetting={onSetting}
            onVoiceTerms={onVoiceTerms}
            playingKey={playingKey}
            section={section}
            snapshot={snapshot}
            sourceLoading={sourceLoading}
            sources={sources}
          />
        </div>
      </div>
    </section>
  );
}
