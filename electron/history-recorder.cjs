"use strict";

const { encodePcm16Wav } = require("./wav.cjs");
const { targetAppLabel } = require("./target-apps.cjs");

const DEFAULT_SILENCE_THRESHOLD = 0.0015;
const DEFAULT_SILENCE_SPLIT_MS = 650;
const DEFAULT_IDLE_FLUSH_MS = 1_200;
const DEFAULT_MAX_SEGMENT_MS = 20_000;

function frameRms(frame) {
  const pcm = frame?.pcm;
  if (!Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length % 4 !== 0) {
    throw new Error("Converted history frame must contain aligned f32le PCM");
  }
  let sum = 0;
  for (let offset = 0; offset < pcm.length; offset += 4) {
    const value = pcm.readFloatLE(offset);
    const sample = Number.isFinite(value) ? value : 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / (pcm.length / 4));
}

function validateFrame(frame) {
  if (!frame || frame.sampleFormat !== "f32le" ||
      !Number.isInteger(frame.sampleRate) || frame.sampleRate < 8_000 || frame.sampleRate > 192_000 ||
      !Number.isInteger(frame.channels) || frame.channels < 1 || frame.channels > 2 ||
      !Number.isInteger(frame.samplesPerChannel) || frame.samplesPerChannel <= 0 ||
      !Buffer.isBuffer(frame.pcm) || frame.pcm.length !== frame.samplesPerChannel * frame.channels * 4) {
    throw new Error("Converted history frame format is invalid");
  }
}

class ConvertedHistoryRecorder {
  constructor({
    historyStore,
    getSettings,
    onEntry = () => {},
    onError = () => {},
    clock = () => new Date(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    silenceThreshold = DEFAULT_SILENCE_THRESHOLD,
    silenceSplitMs = DEFAULT_SILENCE_SPLIT_MS,
    idleFlushMs = DEFAULT_IDLE_FLUSH_MS,
    maxSegmentMs = DEFAULT_MAX_SEGMENT_MS,
  }) {
    this.historyStore = historyStore;
    this.getSettings = getSettings;
    this.onEntry = onEntry;
    this.onError = onError;
    this.clock = clock;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.silenceThreshold = silenceThreshold;
    this.silenceSplitMs = silenceSplitMs;
    this.idleFlushMs = idleFlushMs;
    this.maxSegmentMs = maxSegmentMs;
    this.current = null;
    this.pendingSilence = [];
    this.pendingSilenceSamples = 0;
    this.idleTimer = null;
  }

  accept(outputFrame, sourceFrame = null) {
    try {
      const settings = this.getSettings();
      if (!settings.saveConvertedAudio) {
        this.discard();
        return;
      }
      validateFrame(outputFrame);
      const itemId = outputFrame.itemId ?? sourceFrame?.itemId ?? null;
      if (this.current && itemId !== null && this.current.itemId !== null && itemId !== this.current.itemId) {
        this.flush();
      }
      if (this.current && (this.current.sampleRate !== outputFrame.sampleRate ||
          this.current.channels !== outputFrame.channels)) {
        this.flush();
      }

      const silence = frameRms(outputFrame) <= this.silenceThreshold;
      if (silence) {
        if (!this.current) return;
        this.pendingSilence.push(Buffer.from(outputFrame.pcm));
        this.pendingSilenceSamples += outputFrame.samplesPerChannel;
        const pendingMs = this.pendingSilenceSamples * 1000 / outputFrame.sampleRate;
        if (pendingMs >= this.silenceSplitMs) this.flush();
        else this.scheduleIdleFlush();
        return;
      }

      if (!this.current) {
        const voiceName = settings.selectedVoiceName;
        if (!voiceName) throw new Error("Converted history requires a selected voice name");
        this.current = {
          createdAt: this.clock(),
          itemId,
          sampleRate: outputFrame.sampleRate,
          channels: outputFrame.channels,
          chunks: [],
          samplesPerChannel: 0,
          sourceName: settings.sourceMode === "codex-app-server"
            ? "Codex realtime"
            : settings.sourceName || targetAppLabel(settings.targetApp),
          voiceName,
        };
      }

      if (this.pendingSilence.length > 0) {
        this.current.chunks.push(...this.pendingSilence);
        this.current.samplesPerChannel += this.pendingSilenceSamples;
        this.pendingSilence = [];
        this.pendingSilenceSamples = 0;
      }
      this.current.chunks.push(Buffer.from(outputFrame.pcm));
      this.current.samplesPerChannel += outputFrame.samplesPerChannel;
      const durationMs = this.current.samplesPerChannel * 1000 / this.current.sampleRate;
      if (durationMs >= this.maxSegmentMs) this.flush();
      else this.scheduleIdleFlush();
    } catch (error) {
      this.discard();
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  scheduleIdleFlush() {
    if (this.idleTimer) this.clearTimer(this.idleTimer);
    this.idleTimer = this.setTimer(() => {
      this.idleTimer = null;
      this.flush();
    }, this.idleFlushMs);
    this.idleTimer?.unref?.();
  }

  flush() {
    if (this.idleTimer) this.clearTimer(this.idleTimer);
    this.idleTimer = null;
    const segment = this.current;
    this.current = null;
    this.pendingSilence = [];
    this.pendingSilenceSamples = 0;
    if (!segment || segment.samplesPerChannel === 0) return null;
    try {
      const audio = encodePcm16Wav(segment);
      const entry = this.historyStore.addWav({
        audio,
        createdAt: segment.createdAt,
        durationMs: segment.samplesPerChannel * 1000 / segment.sampleRate,
        voiceName: segment.voiceName,
        sourceName: segment.sourceName,
      });
      this.onEntry(entry);
      return entry;
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }

  discard() {
    if (this.idleTimer) this.clearTimer(this.idleTimer);
    this.idleTimer = null;
    this.current = null;
    this.pendingSilence = [];
    this.pendingSilenceSamples = 0;
  }
}

module.exports = {
  ConvertedHistoryRecorder,
  DEFAULT_IDLE_FLUSH_MS,
  DEFAULT_MAX_SEGMENT_MS,
  DEFAULT_SILENCE_SPLIT_MS,
  DEFAULT_SILENCE_THRESHOLD,
  frameRms,
  validateFrame,
};
