import type { ChatMessage, CompiledTimeline, TimelineSettings } from "./types";

export const DEFAULT_TIMELINE_SETTINGS: TimelineSettings = {
  mode: "adaptive",
  baseInterval: 1.05,
  maxPause: 3,
  speedFactor: 3600,
  endHold: 2.5,
};

export const VIDEO_PREVIEW_SECONDS = 4;

function readingBonus(message: ChatMessage): number {
  if (message.attachment?.kind === "video") return VIDEO_PREVIEW_SECONDS;
  if (message.kind === "media") return 0.8;
  return Math.min(1.6, Math.max(0, message.text.length - 45) / 130);
}

function eventDelay(
  previous: ChatMessage,
  current: ChatMessage,
  settings: TimelineSettings,
): number {
  if (settings.mode === "fixed") return settings.baseInterval + readingBonus(previous);
  const realGapSeconds = Math.max(0, (current.timestamp.getTime() - previous.timestamp.getTime()) / 1000);
  if (settings.mode === "factor") {
    return Math.min(settings.maxPause, Math.max(0.25, realGapSeconds / Math.max(1, settings.speedFactor))) + readingBonus(previous);
  }
  const timestampInfluence = Math.log1p(realGapSeconds / 45) * 0.38;
  return Math.min(settings.maxPause, settings.baseInterval + timestampInfluence) + readingBonus(previous);
}

export function compileTimeline(
  messages: ChatMessage[],
  settings: TimelineSettings = DEFAULT_TIMELINE_SETTINGS,
): CompiledTimeline {
  if (!messages.length) return { events: [], duration: 0 };
  let at = 0.6;
  const events = messages.map((message, messageIndex) => {
    if (messageIndex > 0) {
      const previous = messages[messageIndex - 1];
      if (previous) at += eventDelay(previous, message, settings);
    }
    return { message, messageIndex, at, revealDuration: 0.22 };
  });
  const lastMessage = messages[messages.length - 1];
  const finalHold = lastMessage?.attachment?.kind === "video"
    ? Math.max(settings.endHold, VIDEO_PREVIEW_SECONDS + 0.3)
    : settings.endHold;
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
