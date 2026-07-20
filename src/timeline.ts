import type { ChatMessage, CompiledTimeline, TimelineSettings } from "./types";

export const DEFAULT_TIMELINE_SETTINGS: TimelineSettings = {
  mode: "adaptive",
  baseInterval: 1.05,
  maxPause: 3,
  speedFactor: 3600,
  endHold: 2.5,
};

export const UNKNOWN_MEDIA_FALLBACK_SECONDS = 4;
export const GIF_PLAYBACK_SECONDS = 4;
// Kept as compatibility aliases for integrations that imported the old names.
export const MEDIA_PREVIEW_SECONDS = UNKNOWN_MEDIA_FALLBACK_SECONDS;
export const VIDEO_PREVIEW_SECONDS = UNKNOWN_MEDIA_FALLBACK_SECONDS;

function knownDuration(value: number | undefined): number | undefined {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value : undefined;
}

export function messageMediaDuration(
  message: ChatMessage,
  mediaDurations: ReadonlyMap<string, number> = new Map(),
): number | undefined {
  const attachment = message.attachment;
  if (!attachment || attachment.status !== "found") return undefined;
  const probedDuration = knownDuration(mediaDurations.get(attachment.archivePath));
  if (probedDuration !== undefined) return probedDuration;
  if (attachment.kind === "video" || attachment.kind === "audio") {
    return UNKNOWN_MEDIA_FALLBACK_SECONDS;
  }
  if (attachment.mimeType === "image/gif" || /\.gif$/iu.test(attachment.displayName)) {
    return GIF_PLAYBACK_SECONDS;
  }
  return undefined;
}

function readingBonus(message: ChatMessage): number {
  const visibleText = message.displayText ?? message.text;
  const lineBonus = Math.max(0, visibleText.split("\n").length - 1) * 0.28;
  const lengthBonus = Math.max(0, visibleText.length - 45) / 85;
  const estimate = Math.min(18, lengthBonus + lineBonus);
  return message.kind === "media" ? Math.max(0.8, estimate) : estimate;
}

function eventDelay(
  previous: ChatMessage,
  current: ChatMessage,
  settings: TimelineSettings,
  previousMediaDuration?: number,
): number {
  let normalDelay: number;
  if (settings.mode === "fixed") normalDelay = settings.baseInterval + readingBonus(previous);
  else {
    const realGapSeconds = Math.max(0, (current.timestamp.getTime() - previous.timestamp.getTime()) / 1000);
    if (settings.mode === "factor") {
      normalDelay = Math.min(settings.maxPause, Math.max(0.25, realGapSeconds / Math.max(1, settings.speedFactor))) + readingBonus(previous);
    } else {
      const timestampInfluence = Math.log1p(realGapSeconds / 45) * 0.38;
      normalDelay = Math.min(settings.maxPause, settings.baseInterval + timestampInfluence) + readingBonus(previous);
    }
  }
  return previousMediaDuration
    ? Math.max(normalDelay, previousMediaDuration + 0.3)
    : normalDelay;
}

export function compileTimeline(
  messages: ChatMessage[],
  settings: TimelineSettings = DEFAULT_TIMELINE_SETTINGS,
  mediaDurations: ReadonlyMap<string, number> = new Map(),
): CompiledTimeline {
  if (!messages.length) return { events: [], duration: 0 };
  let at = 0.6;
  const events = messages.map((message, messageIndex) => {
    if (messageIndex > 0) {
      const previous = messages[messageIndex - 1];
      if (previous) at += eventDelay(previous, message, settings, messageMediaDuration(previous, mediaDurations));
    }
    return {
      message,
      messageIndex,
      at,
      revealDuration: 0.22,
      mediaDuration: messageMediaDuration(message, mediaDurations),
    };
  });
  const lastEvent = events[events.length - 1];
  const lastReadingHold = lastEvent ? readingBonus(lastEvent.message) + settings.baseInterval : 0;
  const finalHold = lastEvent?.mediaDuration
    ? Math.max(settings.endHold, lastEvent.mediaDuration + 0.3, lastReadingHold)
    : Math.max(settings.endHold, lastReadingHold);
  return { events, duration: at + finalHold };
}

export function visibleEventCount(timeline: CompiledTimeline, time: number): number {
  let low = 0;
  let high = timeline.events.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const event = timeline.events[mid];
    if (event && event.at <= time) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const rounded = Math.ceil(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}
