import { ALL_FORMATS, AudioBufferSink, BlobSource, Input, VideoSample, VideoSampleSink } from "mediabunny";
import { visibleEventCount } from "./timeline";
import { parseVCard, type ContactCardInfo } from "./vcard";
import type {
  AudioMediaInfo,
  ArchiveAsset,
  ChatMessage,
  CompiledTimeline,
  ImportedProject,
  PcmAudioClip,
  RenderTheme,
  ScheduledAudioAsset,
} from "./types";

type DrawableImage = ImageBitmap | HTMLImageElement | HTMLCanvasElement;

interface VideoDecoderEntry {
  input: Input<BlobSource>;
  sink: VideoSampleSink;
  firstTimestamp: number;
  duration: number;
  width: number;
  height: number;
  frame: VideoSample | null;
  frameTime: number;
  pending: Promise<void> | null;
  exportIterator: AsyncGenerator<VideoSample | null, void, unknown> | null;
  exportTimes: number[];
  exportCursor: number;
  exportFallback: boolean;
}

interface AudioDecoderEntry extends AudioMediaInfo {
  input: Input<BlobSource>;
  sink: AudioBufferSink;
  firstTimestamp: number;
  startOffset: number;
}

interface AnimatedImageEntry {
  decoder: ImageDecoder;
  width: number;
  height: number;
  frameDurations: number[];
  totalDuration: number;
  frame: VideoFrame | null;
  frameIndex: number;
  pending: Promise<void> | null;
}

export interface MessageCardPresentation {
  type: "call" | "location" | "contact" | "poll" | "reaction" | "payment" | "link" | "invite" | "business" | "interactive" | "template" | "event" | "view-once" | "unsupported" | "deleted" | "omitted";
  icon: string;
  title: string;
  detail?: string;
  body?: string;
  items: string[];
  accent: string;
}

interface BubbleLayout {
  message: ChatMessage;
  lines: string[];
  quoteLines: string[];
  senderLabel: string;
  width: number;
  height: number;
  mediaWidth: number;
  mediaHeight: number;
  card?: MessageCardPresentation;
  cardDetailLines: string[];
  cardItemLines: string[][];
  cardItemHeights: number[];
  cardWidth: number;
  cardHeight: number;
  dateLabel?: string;
}

export function fitMediaBox(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  if (sourceWidth <= 0 || sourceHeight <= 0) return { width: maxWidth, height: Math.min(maxHeight, maxWidth * 9 / 16) };
  const factor = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
  return { width: sourceWidth * factor, height: sourceHeight * factor };
}

export function shouldRenderCircularVideoNote(
  role: ChatMessage["mediaRole"],
  width: number,
  height: number,
): boolean {
  if (role !== "video-note" || width <= 0 || height <= 0) return false;
  return Math.abs(width - height) / Math.max(width, height) <= 0.08;
}

export function canvasScale(width: number, height: number): number {
  return Math.max(0.1, Math.min(width / 1080, height / 1080));
}

export function animatedFrameIndex(frameDurations: number[], time: number, totalDuration: number): number {
  if (!frameDurations.length || totalDuration <= 0) return 0;
  const localTime = ((time % totalDuration) + totalDuration) % totalDuration;
  let boundary = 0;
  for (let index = 0; index < frameDurations.length; index += 1) {
    boundary += frameDurations[index] ?? 0;
    if (localTime < boundary - 1e-9) return index;
  }
  return frameDurations.length - 1;
}

export const MAX_ANIMATED_IMAGE_FRAMES = 5_000;
export const MAX_ANIMATED_CYCLE_SECONDS = 15 * 60;
export const MAX_ANIMATED_DECODE_PIXELS = 2_000_000_000;

/**
 * Bounds the CPU work needed to inspect an animation. A rejected animation is
 * rendered through the existing static first-frame fallback; it is never
 * presented as a misleading partial loop.
 */
export function isSafeAnimatedImageCycle(
  frameCount: number,
  decodedPixels: number,
  duration: number,
): boolean {
  return Number.isInteger(frameCount)
    && frameCount >= 1
    && frameCount <= MAX_ANIMATED_IMAGE_FRAMES
    && Number.isFinite(decodedPixels)
    && decodedPixels >= 0
    && decodedPixels <= MAX_ANIMATED_DECODE_PIXELS
    && Number.isFinite(duration)
    && duration >= 0
    && duration <= MAX_ANIMATED_CYCLE_SECONDS;
}

export function isFirstAttachmentGroupItem(message: ChatMessage): boolean {
  const group = message.attachmentGroup;
  return !group || group.size <= 1 || group.index <= 0;
}

export function isLastAttachmentGroupItem(message: ChatMessage): boolean {
  const group = message.attachmentGroup;
  return !group || group.size <= 1 || group.index >= group.size - 1;
}

export function attachmentGroupIndexLabel(message: ChatMessage): string | undefined {
  const group = message.attachmentGroup;
  if (!group || group.size <= 1 || group.index < 0 || group.index >= group.size) return undefined;
  return `${group.index + 1}/${group.size}`;
}

export function messagesShareAttachmentGroup(current: ChatMessage, next: ChatMessage | undefined): boolean {
  const currentGroup = current.attachmentGroup;
  const nextGroup = next?.attachmentGroup;
  return Boolean(
    currentGroup
    && nextGroup
    && currentGroup.size > 1
    && currentGroup.id === nextGroup.id
    && nextGroup.index === currentGroup.index + 1,
  );
}

export function messageGapAfter(current: ChatMessage, next: ChatMessage | undefined, scale = 1): number {
  return (messagesShareAttachmentGroup(current, next) ? 5 : 15) * scale;
}

export function shouldShowMessageTimestamp(message: ChatMessage): boolean {
  return isLastAttachmentGroupItem(message);
}

export function forwardedPresentationLabel(message: ChatMessage): string | undefined {
  if (!isFirstAttachmentGroupItem(message)) return undefined;
  if (message.frequentlyForwarded) return "↪  HÄUFIG WEITERGELEITET";
  return message.forwarded ? "↪  WEITERGELEITET" : undefined;
}

export function combinedPlaybackDuration(
  videoDuration: number | undefined,
  audioDuration: number | undefined,
  audioStartOffset = 0,
): number | undefined {
  const videoEnd = Number.isFinite(videoDuration) && (videoDuration ?? 0) > 0 ? videoDuration : undefined;
  const audioEnd = Number.isFinite(audioDuration) && (audioDuration ?? 0) > 0
    ? Math.max(0, audioStartOffset + (audioDuration ?? 0))
    : undefined;
  if (videoEnd === undefined) return audioEnd;
  if (audioEnd === undefined) return videoEnd;
  return Math.max(videoEnd, audioEnd);
}

export function oversizedBubbleScrollOffset(
  entryHeight: number,
  availableHeight: number,
  elapsed: number,
  displaySpan: number,
): number {
  const overflow = Math.max(0, entryHeight - availableHeight);
  if (!overflow) return 0;
  const span = Math.max(0.8, displaySpan);
  const progress = clamp((elapsed - 0.35) / Math.max(0.25, span - 0.7), 0, 1);
  return overflow * (1 - progress);
}

export function messageCardPresentation(message: ChatMessage): MessageCardPresentation | undefined {
  const semantic = message.semantic;
  if (semantic) {
    const styles: Record<typeof semantic.type, { icon: string; accent: string }> = {
      call: { icon: semantic.variant?.includes("video") ? "▰" : "☎", accent: "#25a56a" },
      location: { icon: "●", accent: "#348dcc" },
      contact: { icon: "●", accent: "#7c5ac7" },
      poll: { icon: "▥", accent: "#00a884" },
      reaction: { icon: "♥", accent: "#e09f25" },
      payment: {
        icon: "€",
        accent: ["failed", "cancelled", "expired"].includes(semantic.variant ?? "")
          ? "#d86b65"
          : ["pending", "requested"].includes(semantic.variant ?? "") ? "#e09f25" : "#25a56a",
      },
      link: { icon: "↗", accent: "#348dcc" },
      invite: { icon: "+", accent: "#25a56a" },
      business: { icon: "▤", accent: "#7c5ac7" },
      interactive: { icon: "☷", accent: "#00a884" },
      template: { icon: "▤", accent: "#7c5ac7" },
      event: { icon: semantic.variant?.startsWith("rsvp") || semantic.variant === "chat-event" ? "▦" : "i", accent: semantic.variant?.startsWith("rsvp") || semantic.variant === "chat-event" ? "#7c5ac7" : "#647985" },
      "view-once": { icon: "1", accent: "#7c5ac7" },
      unsupported: { icon: "!", accent: "#d97706" },
    };
    const style = styles[semantic.type];
    return {
      type: semantic.type,
      icon: style.icon,
      title: semantic.title,
      detail: semantic.detail,
      body: semantic.body,
      items: semantic.items ?? [],
      accent: style.accent,
    };
  }
  if (message.kind === "deleted") {
    const mine = /^(?:you deleted|du hast)/iu.test(message.text.replace(/[\u200E\u200F]/gu, "").trim());
    return {
      type: "deleted",
      icon: "⌫",
      title: mine ? "Von dir gelöscht" : "Nachricht gelöscht",
      detail: "Der ursprüngliche Inhalt ist nicht im Export enthalten.",
      items: [],
      accent: "#75858e",
    };
  }
  if (message.kind === "media-omitted" && !message.attachment) {
    const labels = { image: "Bild", video: "Video", audio: "Audio", sticker: "Sticker", document: "Dokument" } as const;
    const roleLabel = message.mediaRole === "voice-note"
      ? "Sprachnachricht"
      : message.mediaRole === "video-note"
        ? "Videonotiz"
        : message.mediaRole === "animated-image"
          ? "GIF / Animation"
          : message.mediaRole === "contact"
            ? "Kontaktkarte"
          : undefined;
    return {
      type: "omitted",
      icon: "▧",
      title: roleLabel ? `${roleLabel} nicht enthalten` : message.mediaHint ? `${labels[message.mediaHint]} nicht enthalten` : "Medium nicht enthalten",
      detail: "WhatsApp hat für diesen Eintrag keine eindeutig zuordenbare Datei exportiert.",
      body: (message.displayText ?? message.text).split("\n").slice(1).join("\n").trim() || undefined,
      items: [],
      accent: "#75858e",
    };
  }
  return undefined;
}

export function attachmentCardPresentation(message: ChatMessage): { icon: string; title: string; detail: string } | undefined {
  const attachment = message.attachment;
  if (!attachment) return undefined;
  const extension = attachment.displayName.includes(".")
    ? attachment.displayName.split(".").pop()?.toLocaleUpperCase() ?? "DATEI"
    : "DATEI";
  if (attachment.status === "missing") return { icon: "!", title: "DATEI FEHLT", detail: attachment.displayName };
  if (attachment.status === "ambiguous") return { icon: "?", title: "DATEI NICHT EINDEUTIG", detail: attachment.displayName };
  if (message.mediaRole === "contact" || /\.(?:vcf|vcard)$/iu.test(attachment.displayName)) return { icon: "●", title: "KONTAKT", detail: attachment.displayName };
  if (message.mediaRole === "voice-note") return { icon: "▶", title: "SPRACHNACHRICHT", detail: attachment.displayName };
  if (message.mediaRole === "video-note") return { icon: "▶", title: "VIDEONOTIZ", detail: attachment.displayName };
  if (message.mediaRole === "animated-image") return { icon: "▧", title: "GIF / ANIMATION", detail: attachment.displayName };
  if (attachment.kind === "document") return { icon: "▤", title: `${extension}-DOKUMENT`, detail: attachment.displayName };
  if (attachment.kind === "video") return { icon: "▶", title: "VIDEO", detail: attachment.displayName };
  if (attachment.kind === "audio") return { icon: "▶", title: "AUDIO", detail: attachment.displayName };
  return { icon: "▧", title: attachment.kind === "sticker" ? "STICKER" : "BILD", detail: attachment.displayName };
}

const AUDIO_SAMPLE_RATE = 48_000;
const AUDIO_SEGMENT_SECONDS = 8;
const MAX_DECODABLE_MEDIA_BYTES = 750 * 1024 * 1024;
const MAX_MEDIA_DIMENSION = 32_768;
const MAX_MEDIA_PIXELS = 80_000_000;

function assertSafeMediaDimensions(width: number, height: number): void {
  if (
    !Number.isFinite(width) || !Number.isFinite(height) ||
    width <= 0 || height <= 0 ||
    width > MAX_MEDIA_DIMENSION || height > MAX_MEDIA_DIMENSION ||
    width * height > MAX_MEDIA_PIXELS
  ) {
    throw new Error(`Unsichere Medienabmessungen: ${width} × ${height}`);
  }
}

function mixAudioBuffer(
  left: Float32Array<ArrayBuffer>,
  right: Float32Array<ArrayBuffer>,
  buffer: AudioBuffer,
  localStart: number,
): void {
  const sourceLeft = buffer.getChannelData(0);
  const sourceRight = buffer.getChannelData(Math.min(1, buffer.numberOfChannels - 1));
  // Half-open packet ranges ensure adjacent decoded buffers never write the
  // same resampled output frame (important for 44.1 kHz AAC packet borders).
  const firstOutput = Math.max(0, Math.ceil(localStart * AUDIO_SAMPLE_RATE));
  const lastOutput = Math.min(left.length, Math.ceil((localStart + buffer.duration) * AUDIO_SAMPLE_RATE));
  for (let outputIndex = firstOutput; outputIndex < lastOutput; outputIndex += 1) {
    const sourcePosition = (outputIndex / AUDIO_SAMPLE_RATE - localStart) * buffer.sampleRate;
    if (sourcePosition < 0) continue;
    const sourceIndex = Math.floor(sourcePosition);
    if (sourceIndex >= sourceLeft.length) break;
    const fraction = sourcePosition - sourceIndex;
    const nextIndex = Math.min(sourceLeft.length - 1, sourceIndex + 1);
    const leftValue = (sourceLeft[sourceIndex] ?? 0) + ((sourceLeft[nextIndex] ?? 0) - (sourceLeft[sourceIndex] ?? 0)) * fraction;
    const rightValue = (sourceRight[sourceIndex] ?? 0) + ((sourceRight[nextIndex] ?? 0) - (sourceRight[sourceIndex] ?? 0)) * fraction;
    left[outputIndex] = (left[outputIndex] ?? 0) + leftValue;
    right[outputIndex] = (right[outputIndex] ?? 0) + rightValue;
  }
}

function waveformPeaks(left: Float32Array<ArrayBuffer>, right: Float32Array<ArrayBuffer>, count = 42): number[] {
  const result: number[] = [];
  const step = Math.max(1, Math.ceil(left.length / count));
  for (let bar = 0; bar < count; bar += 1) {
    let peak = 0;
    const end = Math.min(left.length, (bar + 1) * step);
    for (let index = bar * step; index < end; index += 1) {
      peak = Math.max(peak, Math.abs(left[index] ?? 0), Math.abs(right[index] ?? 0));
    }
    result.push(Math.min(1, Math.max(0.08, peak)));
  }
  return result;
}

function placeholderWaveformPeaks(count = 42): number[] {
  return Array.from({ length: count }, (_, index) => 0.12 + Math.abs(Math.sin((index + 1) * 1.37)) * 0.18);
}

interface Palette {
  background: string;
  pattern: string;
  header: string;
  headerText: string;
  headerMuted: string;
  incoming: string;
  outgoing: string;
  text: string;
  mutedText: string;
  system: string;
  input: string;
  accent: string;
  media: string;
}

const LIGHT: Palette = {
  background: "#efeae2",
  pattern: "rgba(92, 88, 81, .08)",
  header: "#f0f2f5",
  headerText: "#111b21",
  headerMuted: "#667781",
  incoming: "#ffffff",
  outgoing: "#d9fdd3",
  text: "#111b21",
  mutedText: "#667781",
  system: "#ffffffd9",
  input: "#ffffff",
  accent: "#00a884",
  media: "#d9e1e5",
};

const DARK: Palette = {
  background: "#0b141a",
  pattern: "rgba(177, 185, 189, .055)",
  header: "#202c33",
  headerText: "#e9edef",
  headerMuted: "#8696a0",
  incoming: "#202c33",
  outgoing: "#005c4b",
  text: "#e9edef",
  mutedText: "#8696a0",
  system: "#182229e8",
  input: "#202c33",
  accent: "#00a884",
  media: "#26363e",
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function graphemes(value: string): string[] {
  const Segmenter = (Intl as unknown as {
    Segmenter?: new (locale?: string, options?: { granularity: "grapheme" }) => {
      segment(input: string): Iterable<{ segment: string }>;
    };
  }).Segmenter;
  if (!Segmenter) return Array.from(value);
  return Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(value), ({ segment }) => segment);
}

function easeOut(value: number): number {
  return 1 - Math.pow(1 - clamp(value, 0, 1), 3);
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function initials(value: string): string {
  const parts = value.trim().split(/\s+/u).filter(Boolean);
  return (parts.slice(0, 2).map((part) => part[0]?.toLocaleUpperCase() ?? "").join("") || "WA").slice(0, 2);
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatDay(date: Date): string {
  const today = new Date();
  if (dayKey(date) === dayKey(today)) return "HEUTE";
  return new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "short", year: "numeric" }).format(date).toLocaleUpperCase();
}

function formatTime(date: Date): string {
  return new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" }).format(date);
}

export function cleanMediaCaption(message: ChatMessage): string {
  const sourceText = message.displayText ?? message.text;
  if (!message.attachment) return sourceText;
  const normalizedText = sourceText.replace(/[\u200E\u200F]/gu, "").trim().normalize("NFC").toLocaleLowerCase();
  const normalizedReference = (message.mediaReference ?? message.attachment.displayName).trim().normalize("NFC").toLocaleLowerCase();
  if (normalizedText === normalizedReference) return "";
  const withoutTag = sourceText
    .replace(/[\u200E\u200F]?\s*<(?:attached|attachment|anhang|datei|angehängt|angehaengt):\s*[^>\n]{1,255}>/iu, "")
    .replace(/^[^\n]{1,255}?\s+\((?:file attached|datei angehängt|datei angehaengt|angehängt|attached)\)\s*/iu, "")
    .trim();
  const withoutControls = withoutTag.replace(/[\u200E\u200F]/gu, "").trim();
  if (/^.{1,255}?\s*[•·]\s*\d+\s+(?:pages?|seiten?)$/iu.test(withoutControls)) return "";
  if (withoutTag !== sourceText.trim()) return withoutTag;
  if (message.kind === "media-omitted") return sourceText.split("\n").slice(1).join("\n").trim();
  return sourceText;
}

function pseudonym(name: string, participants: string[]): string {
  const index = Math.max(0, participants.indexOf(name));
  return `Person ${String.fromCharCode(65 + (index % 26))}`;
}

function senderLabel(message: ChatMessage, theme: RenderTheme, participants: string[]): string {
  if (!isFirstAttachmentGroupItem(message)) return "";
  if (!message.sender || message.sender === theme.selfName) return "";
  return theme.anonymize ? pseudonym(message.sender, participants) : message.sender;
}

export class AssetMediaStore {
  private readonly assets = new Map<string, ArchiveAsset>();
  private readonly images = new Map<string, DrawableImage>();
  private readonly animatedImages = new Map<string, AnimatedImageEntry>();
  private readonly contactCards = new Map<string, ContactCardInfo>();
  private readonly videos = new Map<string, VideoDecoderEntry>();
  private readonly audioDecoders = new Map<string, AudioDecoderEntry>();
  private readonly audioMetadata = new Map<string, AudioMediaInfo>();
  private readonly audioLoading = new Map<string, Promise<AudioDecoderEntry | undefined>>();
  private readonly audioMetadataLoading = new Map<string, Promise<AudioMediaInfo | undefined>>();
  private readonly failedAudio = new Set<string>();
  private readonly noAudioTrack = new Set<string>();
  private readonly blobs = new Map<string, Promise<Blob>>();
  private readonly objectUrls = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly loading = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(project: ImportedProject) {
    for (const asset of project.assets) this.assets.set(asset.path, asset);
  }

  getImage(path: string): DrawableImage | undefined {
    return this.images.get(path);
  }

  getVideoFrame(path: string): VideoSample | null | undefined {
    return this.videos.get(path)?.frame;
  }

  getVideoDuration(path: string): number | undefined {
    return this.videos.get(path)?.duration;
  }

  getAnimatedFrame(path: string): VideoFrame | undefined {
    return this.animatedImages.get(path)?.frame ?? undefined;
  }

  isAnimatedImage(path: string): boolean {
    return this.animatedImages.has(path);
  }

  getAudioInfo(path: string): AudioMediaInfo | undefined {
    const entry = this.audioDecoders.get(path) ?? this.audioMetadata.get(path);
    return entry ? { duration: entry.duration, peaks: entry.peaks } : undefined;
  }

  getContactCard(path: string): ContactCardInfo | undefined {
    return this.contactCards.get(path);
  }

  getPlaybackDuration(path: string): number | undefined {
    const video = this.videos.get(path);
    const audio = this.audioDecoders.get(path);
    if (video) return combinedPlaybackDuration(video.duration, audio?.duration, audio?.startOffset);
    return audio?.duration ?? this.audioMetadata.get(path)?.duration ?? this.animatedImages.get(path)?.totalDuration;
  }

  getAudioTiming(path: string): { duration: number; startOffset: number } | undefined {
    const decoder = this.audioDecoders.get(path);
    if (decoder) return { duration: decoder.duration, startOffset: decoder.startOffset };
    const metadata = this.audioMetadata.get(path);
    return metadata ? { duration: metadata.duration, startOffset: 0 } : undefined;
  }

  getKnownMediaDurations(): ReadonlyMap<string, number> {
    const durations = new Map<string, number>();
    for (const [path, entry] of this.animatedImages) durations.set(path, entry.totalDuration);
    for (const [path, entry] of this.videos) durations.set(path, entry.duration);
    for (const [path, entry] of this.audioMetadata) {
      if (!durations.has(path)) durations.set(path, entry.duration);
    }
    for (const [path, entry] of this.audioDecoders) {
      const videoDuration = this.videos.get(path)?.duration;
      const duration = combinedPlaybackDuration(videoDuration, entry.duration, entry.startOffset);
      if (duration !== undefined) durations.set(path, duration);
    }
    return durations;
  }

  getMediaDimensions(path: string): { width: number; height: number } | undefined {
    const video = this.videos.get(path);
    if (video) return { width: video.width, height: video.height };
    const animated = this.animatedImages.get(path);
    if (animated) return { width: animated.width, height: animated.height };
    const image = this.images.get(path);
    if (!image) return undefined;
    return {
      width: "naturalWidth" in image ? image.naturalWidth : image.width,
      height: "naturalHeight" in image ? image.naturalHeight : image.height,
    };
  }

  getScheduledAudioAssets(timeline: CompiledTimeline): ScheduledAudioAsset[] {
    const result: ScheduledAudioAsset[] = [];
    for (const event of timeline.events) {
      const attachment = event.message.attachment;
      if (attachment?.status !== "found" || !["audio", "video"].includes(attachment.kind)) continue;
      const timing = this.getAudioTiming(attachment.archivePath);
      if (!timing || !Number.isFinite(timing.duration)) {
        if (attachment.kind === "audio") {
          // Keep an unreadable standalone audio attachment in the export plan.
          // The required loader path then reports the error instead of silently
          // producing a video without the requested recording.
          result.push({
            at: event.at,
            path: attachment.archivePath,
            duration: Math.max(0.01, event.mediaDuration ?? 0.01),
            clipStart: 0,
            required: true,
          });
        }
        continue;
      }
      const clipStart = Math.max(0, -timing.startOffset);
      const duration = Math.max(0, timing.duration - clipStart);
      if (duration <= 0) continue;
      result.push({
        at: event.at + Math.max(0, timing.startOffset),
        path: attachment.archivePath,
        duration,
        clipStart,
        required: attachment.kind === "audio",
      });
    }
    return result;
  }

  getMediaIssues(messages: ChatMessage[]): string[] {
    const issues = new Set<string>();
    for (const message of messages) {
      const attachment = message.attachment;
      if (attachment?.status !== "found") continue;
      const label = attachment.displayName.replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, "");
      if (attachment.kind === "video" && !this.videos.has(attachment.archivePath)) {
        issues.add(`Videospur „${label}“ kann nicht dekodiert werden.`);
      } else if (attachment.kind === "video" && this.failedAudio.has(attachment.archivePath) && !this.noAudioTrack.has(attachment.archivePath)) {
        issues.add(`Tonspur von „${label}“ kann nicht dekodiert werden.`);
      } else if (attachment.kind === "audio" && (this.failedAudio.has(attachment.archivePath) || !this.audioMetadata.has(attachment.archivePath))) {
        issues.add(`Audiodatei „${label}“ kann nicht dekodiert werden.`);
      } else if (["image", "sticker"].includes(attachment.kind) && !this.images.has(attachment.archivePath) && !this.animatedImages.has(attachment.archivePath)) {
        issues.add(`Bild „${label}“ kann nicht angezeigt werden.`);
      }
    }
    return [...issues];
  }

  async preloadForMessages(messages: ChatMessage[], onProgress?: (done: number, total: number) => void): Promise<void> {
    const paths = [...new Set(messages
      .filter((message) => message.attachment?.status === "found" && (
        ["image", "sticker", "video", "audio"].includes(message.attachment.kind)
        || (message.attachment.kind === "document" && /\.(?:vcf|vcard)$/iu.test(message.attachment.displayName))
      ))
      .map((message) => message.attachment?.archivePath)
      .filter((path): path is string => Boolean(path)))];
    let done = 0;
    for (const path of paths) {
      const asset = this.assets.get(path);
      if (asset?.kind === "audio") await this.probeAudioMetadata(path);
      else {
        await this.load(path);
        // Some .3gp/.mkv exports contain only an audio track. Probe it even if
        // the visual track is absent or uses a codec the browser cannot decode.
        if (asset?.kind === "video") await this.ensureAudioDecoder(path);
      }
      done += 1;
      onProgress?.(done, paths.length);
    }
  }

  async load(path: string): Promise<void> {
    if (this.disposed) return;
    const asset = this.assets.get(path);
    if (asset?.kind === "audio" && this.failedAudio.has(path)) return;
    if (this.images.has(path) || this.animatedImages.has(path) || this.contactCards.has(path) || this.videos.has(path) || this.audioDecoders.has(path) || this.failed.has(path)) return;
    const activeLoad = this.loading.get(path);
    if (activeLoad) {
      await activeLoad;
      return;
    }
    const pending = this.loadAsset(path);
    this.loading.set(path, pending);
    try {
      await pending;
    } finally {
      this.loading.delete(path);
      if (this.disposed) this.releaseResources();
    }
  }

  private async loadAsset(path: string): Promise<void> {
    const asset = this.assets.get(path);
    if (!asset || asset.size > MAX_DECODABLE_MEDIA_BYTES) {
      this.failed.add(path);
      return;
    }
    try {
      if (asset.kind === "video") {
        await this.loadVideo(asset);
        return;
      }
      if (asset.kind === "audio") {
        await this.ensureAudioDecoder(asset.path);
        return;
      }
      const blob = await this.getBlob(asset);
      if (asset.kind === "document" && /\.(?:vcf|vcard)$/iu.test(asset.basename)) {
        const card = parseVCard(await blob.text());
        if (card) this.contactCards.set(asset.path, card);
        return;
      }
      if (["image/gif", "image/webp"].includes(asset.mimeType) || /\.(?:gif|webp)$/iu.test(asset.basename)) {
        try {
          await this.loadAnimatedImage(asset, blob);
          return;
        } catch {
          await this.loadStaticGifFallback(asset.path, blob);
          return;
        }
      }
      await this.loadStaticImage(asset.path, blob);
    } catch {
      this.failed.add(path);
    } finally {
      // Decoded image objects and ImageDecoder own their data. Keep Blob
      // caching only for audio/video where two track decoders may share it.
      if (asset.kind === "image" || asset.kind === "sticker" || asset.kind === "document") this.blobs.delete(path);
    }
  }

  private async loadStaticImage(path: string, blob: Blob): Promise<void> {
    if (typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
        try {
          assertSafeMediaDimensions(bitmap.width, bitmap.height);
        } catch (error) {
          bitmap.close();
          throw error;
        }
        this.images.set(path, bitmap);
        return;
      } catch {
        // Some formats are supported by <img> even when createImageBitmap rejects them.
      }
    }
    await this.loadHtmlImage(path, blob);
  }

  private async loadHtmlImage(path: string, blob: Blob): Promise<void> {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    try {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("Bild konnte nicht geladen werden"));
        image.src = url;
      });
      assertSafeMediaDimensions(image.naturalWidth, image.naturalHeight);
      this.objectUrls.add(url);
      this.images.set(path, image);
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  }

  private async loadStaticGifFallback(path: string, blob: Blob): Promise<void> {
    if (typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(blob);
        try {
          assertSafeMediaDimensions(bitmap.width, bitmap.height);
        } catch (error) {
          bitmap.close();
          throw error;
        }
        this.images.set(path, bitmap);
        return;
      } catch {
        // Some browsers expose createImageBitmap but cannot decode GIF files.
        // Continue with the HTMLImage/canvas fallback below.
      }
    }
    const url = URL.createObjectURL(blob);
    const image = new Image();
    try {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("GIF konnte nicht geladen werden"));
        image.src = url;
      });
      assertSafeMediaDimensions(image.naturalWidth, image.naturalHeight);
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("GIF-Fallback konnte nicht gerendert werden");
      context.drawImage(image, 0, 0);
      this.images.set(path, canvas);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private async loadAnimatedImage(asset: ArchiveAsset, blob: Blob): Promise<void> {
    const type = asset.mimeType === "image/webp" || /\.webp$/iu.test(asset.basename) ? "image/webp" : "image/gif";
    if (typeof ImageDecoder === "undefined" || !await ImageDecoder.isTypeSupported(type)) {
      throw new Error("Animierte Bilder werden von diesem Browser nicht dekodiert");
    }
    const decoder = new ImageDecoder({
      data: await blob.arrayBuffer(),
      type,
      preferAnimation: true,
    });
    let firstFrame: VideoFrame | null = null;
    try {
      await decoder.tracks.ready;
      const track = decoder.tracks.selectedTrack;
      if (!track || track.frameCount < 1) throw new Error("GIF enthält keine Frames");
      if (type === "image/webp" && track.frameCount < 2) throw new Error("WebP ist nicht animiert");
      if (!isSafeAnimatedImageCycle(track.frameCount, 0, 0)) {
        throw new Error("Animation überschreitet die sichere Frame-Grenze");
      }
      const frameDurations: number[] = [];
      let totalDuration = 0;
      let decodedPixels = 0;
      for (let frameIndex = 0; frameIndex < track.frameCount; frameIndex += 1) {
        const result = await decoder.decode({ frameIndex, completeFramesOnly: true });
        try {
          assertSafeMediaDimensions(result.image.displayWidth, result.image.displayHeight);
          const duration = Math.max(0.02, (result.image.duration ?? 100_000) / 1_000_000);
          const nextDuration = totalDuration + duration;
          const nextDecodedPixels = decodedPixels + result.image.displayWidth * result.image.displayHeight;
          if (!isSafeAnimatedImageCycle(track.frameCount, nextDecodedPixels, nextDuration)) {
            throw new Error("Animation überschreitet die sichere Dekodiergrenze");
          }
          frameDurations.push(duration);
          totalDuration = nextDuration;
          decodedPixels = nextDecodedPixels;
          if (!firstFrame) firstFrame = result.image;
          else result.image.close();
        } catch (error) {
          if (result.image !== firstFrame) result.image.close();
          throw error;
        }
      }
      if (!firstFrame || frameDurations.length !== track.frameCount) throw new Error("GIF konnte nicht vollständig dekodiert werden");
      this.animatedImages.set(asset.path, {
        decoder,
        width: firstFrame.displayWidth,
        height: firstFrame.displayHeight,
        frameDurations,
        totalDuration,
        frame: firstFrame,
        frameIndex: 0,
        pending: null,
      });
      firstFrame = null;
    } catch (error) {
      firstFrame?.close();
      decoder.close();
      throw error;
    }
  }

  private async getBlob(asset: ArchiveAsset): Promise<Blob> {
    const cached = this.blobs.get(asset.path);
    if (cached) return cached;
    const pending = asset.loadBlob().catch((error) => {
      this.blobs.delete(asset.path);
      throw error;
    });
    this.blobs.set(asset.path, pending);
    return pending;
  }

  private async probeAudioMetadata(path: string): Promise<AudioMediaInfo | undefined> {
    const cached = this.audioMetadata.get(path) ?? this.audioDecoders.get(path);
    if (cached) return { duration: cached.duration, peaks: cached.peaks };
    if (this.failedAudio.has(path) || this.noAudioTrack.has(path) || this.disposed) return undefined;
    const active = this.audioMetadataLoading.get(path);
    if (active) return active;
    const asset = this.assets.get(path);
    if (!asset || asset.kind !== "audio" || asset.size > MAX_DECODABLE_MEDIA_BYTES) return undefined;
    const pending = (async (): Promise<AudioMediaInfo | undefined> => {
      let input: Input<BlobSource> | null = null;
      try {
        input = new Input({ source: new BlobSource(await asset.loadBlob()), formats: ALL_FORMATS });
        if (!await input.canRead()) throw new Error("Audioformat nicht lesbar");
        const track = await input.getPrimaryAudioTrack();
        if (!track) throw new Error("Keine Audiospur gefunden");
        const canDecode = await track.canDecode();
        const firstTimestamp = Math.max(0, await track.getFirstTimestamp());
        let endTimestamp = await track.getDurationFromMetadata();
        try { endTimestamp = await track.computeDuration(); } catch { /* Use container metadata as fallback. */ }
        if (endTimestamp === null) throw new Error("Audiodauer konnte nicht bestimmt werden");
        const metadata = { duration: Math.max(0.01, endTimestamp - firstTimestamp), peaks: placeholderWaveformPeaks() };
        if (this.disposed) return undefined;
        this.audioMetadata.set(path, metadata);
        if (!canDecode) this.failedAudio.add(path);
        return metadata;
      } catch {
        this.failedAudio.add(path);
        return undefined;
      } finally {
        input?.dispose();
      }
    })().finally(() => this.audioMetadataLoading.delete(path));
    this.audioMetadataLoading.set(path, pending);
    return pending;
  }

  private async ensureAudioDecoder(path: string): Promise<AudioDecoderEntry | undefined> {
    const cached = this.audioDecoders.get(path);
    if (cached) return cached;
    if (this.failedAudio.has(path) || this.noAudioTrack.has(path) || this.disposed) return undefined;
    const active = this.audioLoading.get(path);
    if (active) return active;
    const asset = this.assets.get(path);
    if (!asset || !["audio", "video"].includes(asset.kind) || asset.size > MAX_DECODABLE_MEDIA_BYTES) {
      this.failedAudio.add(path);
      return undefined;
    }
    const pending = this.createAudioDecoder(asset)
      .catch(() => {
        if (!this.noAudioTrack.has(path)) this.failedAudio.add(path);
        return undefined;
      })
      .finally(() => this.audioLoading.delete(path));
    this.audioLoading.set(path, pending);
    return pending;
  }

  private async createAudioDecoder(asset: ArchiveAsset): Promise<AudioDecoderEntry> {
    let input: Input<BlobSource> | null = null;
    try {
      const blob = await this.getBlob(asset);
      input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
      if (!await input.canRead()) throw new Error("Audioformat nicht lesbar");
      const track = await input.getPrimaryAudioTrack();
      if (!track) {
        this.noAudioTrack.add(asset.path);
        throw new Error("Keine Audiospur gefunden");
      }
      if (!await track.canDecode()) throw new Error("Audiocodec wird von diesem Browser nicht unterstützt");
      const firstTimestamp = Math.max(0, await track.getFirstTimestamp());
      let endTimestamp = await track.getDurationFromMetadata();
      try { endTimestamp = await track.computeDuration(); } catch { /* Use container metadata as fallback. */ }
      if (endTimestamp === null) throw new Error("Audiodauer konnte nicht bestimmt werden");
      const duration = Math.max(0.01, endTimestamp - firstTimestamp);
      const videoFirstTimestamp = this.videos.get(asset.path)?.firstTimestamp;
      const startOffset = videoFirstTimestamp === undefined ? 0 : firstTimestamp - videoFirstTimestamp;
      if (this.disposed) throw new Error("Medienspeicher wurde geschlossen");
      const entry: AudioDecoderEntry = {
        input,
        sink: new AudioBufferSink(track),
        firstTimestamp,
        startOffset,
        duration,
        peaks: this.audioMetadata.get(asset.path)?.peaks ?? placeholderWaveformPeaks(),
      };
      this.audioDecoders.set(asset.path, entry);
      this.audioMetadata.set(asset.path, { duration: entry.duration, peaks: entry.peaks });
      this.failedAudio.delete(asset.path);
      this.noAudioTrack.delete(asset.path);
      input = null;
      return entry;
    } finally {
      input?.dispose();
    }
  }

  async loadAudioSegment(path: string, start: number, requestedDuration = AUDIO_SEGMENT_SECONDS): Promise<PcmAudioClip | undefined> {
    const entry = await this.ensureAudioDecoder(path);
    if (!entry || this.disposed) return undefined;
    const localStart = Math.max(0, Math.min(entry.duration, start));
    const duration = Math.max(0, Math.min(requestedDuration, entry.duration - localStart));
    if (duration <= 0) return undefined;
    const capacity = Math.max(1, Math.ceil(duration * AUDIO_SAMPLE_RATE));
    const left = new Float32Array(new ArrayBuffer(capacity * Float32Array.BYTES_PER_ELEMENT));
    const right = new Float32Array(new ArrayBuffer(capacity * Float32Array.BYTES_PER_ELEMENT));
    let decodedEnd = 0;
    const absoluteStart = entry.firstTimestamp + localStart;
    const absoluteEnd = absoluteStart + duration;
    for await (const wrapped of entry.sink.buffers(absoluteStart, absoluteEnd)) {
      if (this.disposed) return undefined;
      const bufferStart = wrapped.timestamp - absoluteStart;
      mixAudioBuffer(left, right, wrapped.buffer, bufferStart);
      decodedEnd = Math.max(decodedEnd, Math.min(duration, bufferStart + wrapped.duration));
    }
    if (decodedEnd <= 0) throw new Error("Audiodatei enthält keine dekodierbaren Samples");
    if (decodedEnd + 0.08 < duration) {
      throw new Error("Audiodatei konnte nicht bis zum Ende des Segments dekodiert werden");
    }
    const peaks = waveformPeaks(left, right);
    return {
      duration,
      sampleRate: AUDIO_SAMPLE_RATE,
      left,
      right,
      peaks,
    };
  }

  private async loadVideo(asset: ArchiveAsset): Promise<void> {
    let input: Input<BlobSource> | null = null;
    try {
      const blob = await this.getBlob(asset);
      input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
      if (!await input.canRead()) throw new Error("Videoformat nicht lesbar");
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error("Keine Videospur gefunden");
      if (!await track.canDecode()) throw new Error("Videocodec wird von diesem Browser nicht unterstützt");
      const firstTimestamp = Math.max(0, await track.getFirstTimestamp());
      let endTimestamp = await track.getDurationFromMetadata();
      try { endTimestamp = await track.computeDuration(); } catch { /* Use container metadata as fallback. */ }
      if (endTimestamp === null) throw new Error("Videodauer konnte nicht bestimmt werden");
      const [width, height] = await Promise.all([track.getDisplayWidth(), track.getDisplayHeight()]);
      assertSafeMediaDimensions(width, height);
      if (this.disposed) throw new Error("Medienspeicher wurde geschlossen");
      const entry: VideoDecoderEntry = {
        input,
        sink: new VideoSampleSink(track),
        firstTimestamp,
        duration: Math.max(0.01, endTimestamp - firstTimestamp),
        width,
        height,
        frame: null,
        frameTime: -1,
        pending: null,
        exportIterator: null,
        exportTimes: [],
        exportCursor: 0,
        exportFallback: false,
      };
      this.videos.set(asset.path, entry);
      await this.prepareVideoFrame(asset.path, 0, true);
    } catch (error) {
      this.videos.delete(asset.path);
      input?.dispose();
      this.failed.add(asset.path);
      throw error;
    }
  }

  async prepareVideoFrame(path: string, time: number, exact = false): Promise<void> {
    if (!this.videos.has(path) && !this.failed.has(path)) await this.load(path);
    const entry = this.videos.get(path);
    if (!entry) return;
    const requested = exact ? time : Math.floor(time * 15) / 15;
    const target = Math.min(Math.max(0, entry.duration - 0.001), Math.max(0, requested));
    if (Math.abs(entry.frameTime - target) < 0.001) return;
    if (exact && entry.exportIterator && !entry.exportFallback) {
      while (entry.exportCursor < entry.exportTimes.length && (entry.exportTimes[entry.exportCursor] ?? Infinity) <= target + 0.0005) {
        const scheduledTime = entry.exportTimes[entry.exportCursor] ?? target;
        let result: IteratorResult<VideoSample | null, void>;
        try {
          result = await entry.exportIterator.next();
        } catch {
          this.failed.add(path);
          entry.exportFallback = true;
          try { await entry.exportIterator.return(); } catch { /* Keep the last decoded frame. */ }
          entry.exportIterator = null;
          throw new Error(`Video „${this.assets.get(path)?.basename ?? path}“ konnte nicht vollständig dekodiert werden.`);
        }
        entry.exportCursor += 1;
        if (!result.value) continue;
        if (this.disposed) {
          result.value.close();
          return;
        }
        entry.frame?.close();
        entry.frame = result.value;
        entry.frameTime = scheduledTime;
      }
      return;
    }
    if (entry.pending) {
      await entry.pending;
      if (exact && Math.abs(entry.frameTime - target) >= 0.001) await this.prepareVideoFrame(path, target, true);
      return;
    }
    entry.pending = entry.sink.getSample(entry.firstTimestamp + target)
      .then((sample) => {
        if (!sample) return;
        if (this.disposed) {
          sample.close();
          return;
        }
        entry.frame?.close();
        entry.frame = sample;
        entry.frameTime = target;
      })
      .catch(() => {
        this.failed.add(path);
        if (exact) throw new Error(`Video „${this.assets.get(path)?.basename ?? path}“ konnte nicht dekodiert werden.`);
      })
      .finally(() => {
        entry.pending = null;
      });
    await entry.pending;
  }

  async prepareAnimatedFrame(path: string, time: number, exact = false): Promise<void> {
    const entry = this.animatedImages.get(path);
    if (!entry) return;
    const target = exact ? time : Math.floor(time * 15) / 15;
    const nextIndex = animatedFrameIndex(entry.frameDurations, target, entry.totalDuration);
    if (entry.frameIndex === nextIndex && entry.frame) return;
    if (entry.pending) {
      await entry.pending;
      if (exact && entry.frameIndex !== nextIndex) await this.prepareAnimatedFrame(path, target, true);
      return;
    }
    entry.pending = entry.decoder.decode({ frameIndex: nextIndex, completeFramesOnly: true })
      .then((result) => {
        if (this.disposed) {
          result.image.close();
          return;
        }
        try {
          assertSafeMediaDimensions(result.image.displayWidth, result.image.displayHeight);
        } catch (error) {
          result.image.close();
          throw error;
        }
        entry.frame?.close();
        entry.frame = result.image;
        entry.frameIndex = nextIndex;
        entry.width = result.image.displayWidth;
        entry.height = result.image.displayHeight;
      })
      .catch(() => undefined)
      .finally(() => { entry.pending = null; });
    await entry.pending;
  }

  async beginExportSession(timeline: CompiledTimeline, fps: number): Promise<void> {
    await Promise.all([...this.videos.values()].map((entry) => entry.pending).filter((pending): pending is Promise<void> => Boolean(pending)));
    const byPath = new Map<string, { eventAt: number; duration: number }[]>();
    for (const event of timeline.events) {
      const attachment = event.message.attachment;
      if (attachment?.status !== "found" || attachment.kind !== "video") continue;
      const entry = this.videos.get(attachment.archivePath);
      if (!entry) continue;
      const items = byPath.get(attachment.archivePath) ?? [];
      items.push({ eventAt: event.at, duration: Math.min(event.mediaDuration ?? entry.duration, entry.duration) });
      byPath.set(attachment.archivePath, items);
    }
    for (const [path, events] of byPath) {
      const entry = this.videos.get(path);
      if (!entry) continue;
      entry.frame?.close();
      entry.frame = null;
      entry.frameTime = -1;
      entry.exportCursor = 0;
      entry.exportFallback = events.length > 1;
      if (entry.exportFallback) continue;
      const event = events[0];
      if (!event) continue;
      const times: number[] = [];
      const firstFrame = Math.ceil(event.eventAt * fps);
      const lastFrame = Math.floor((event.eventAt + event.duration) * fps);
      for (let frame = firstFrame; frame <= lastFrame; frame += 1) {
        const localTime = Math.min(event.duration - 0.001, Math.max(0, frame / fps - event.eventAt));
        if (localTime >= 0 && (times.length === 0 || Math.abs((times[times.length - 1] ?? -1) - localTime) > 0.0005)) times.push(localTime);
      }
      entry.exportTimes = times;
      entry.exportIterator = entry.sink.samplesAtTimestamps(times.map((time) => entry.firstTimestamp + time));
    }
  }

  async endExportSession(): Promise<void> {
    for (const entry of this.videos.values()) {
      if (entry.exportIterator) await entry.exportIterator.return();
      entry.exportIterator = null;
      entry.exportTimes = [];
      entry.exportCursor = 0;
      entry.exportFallback = false;
    }
  }

  private releaseResources(): void {
    for (const image of this.images.values()) {
      if ("close" in image && typeof image.close === "function") image.close();
    }
    for (const video of this.videos.values()) {
      void video.exportIterator?.return();
      video.frame?.close();
      video.input.dispose();
    }
    for (const animated of this.animatedImages.values()) {
      animated.frame?.close();
      animated.decoder.close();
    }
    for (const audio of this.audioDecoders.values()) audio.input.dispose();
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.images.clear();
    this.animatedImages.clear();
    this.contactCards.clear();
    this.videos.clear();
    this.audioDecoders.clear();
    this.audioMetadata.clear();
    this.audioLoading.clear();
    this.audioMetadataLoading.clear();
    this.failedAudio.clear();
    this.noAudioTrack.clear();
    this.blobs.clear();
    this.objectUrls.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.releaseResources();
  }
}

export class ChatCanvasRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private participants: string[] = [];
  private currentTimeline: CompiledTimeline = { events: [], duration: 0 };
  private currentTime = 0;
  private eventTimes = new Map<string, number>();
  private eventDurations = new Map<string, number>();

  constructor(private readonly canvas: HTMLCanvasElement, private readonly media: AssetMediaStore) {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas wird von diesem Browser nicht unterstützt.");
    this.ctx = context;
  }

  setParticipants(participants: string[]): void {
    this.participants = participants;
  }

  render(timeline: CompiledTimeline, time: number, theme: RenderTheme): void {
    if (this.currentTimeline !== timeline) {
      this.currentTimeline = timeline;
      this.eventTimes = new Map(timeline.events.map((event) => [event.message.id, event.at]));
      this.eventDurations = new Map(timeline.events
        .filter((event) => Boolean(event.mediaDuration))
        .map((event) => [event.message.id, event.mediaDuration ?? 0]));
    }
    this.currentTime = time;
    const ctx = this.ctx;
    const { width: w, height: h } = this.canvas;
    const scale = canvasScale(w, h);
    const palette = theme.mode === "dark" ? DARK : LIGHT;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, w, h);
    this.drawPattern(palette, scale);

    const headerH = 132 * scale;
    const inputH = 118 * scale;
    this.drawHeader(theme, palette, headerH, scale, timeline, time);
    this.drawInputBar(palette, h - inputH, inputH, scale);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, headerH, w, h - headerH - inputH);
    ctx.clip();
    this.drawMessages(timeline, time, theme, palette, h - inputH, scale);
    ctx.restore();
    ctx.restore();
  }

  async prepareFrame(timeline: CompiledTimeline, time: number, exact = false): Promise<void> {
    const visibleCount = visibleEventCount(timeline, time);
    const events = timeline.events.slice(Math.max(0, visibleCount - 90), visibleCount);
    const promises: Promise<void>[] = [];
    for (const event of events) {
      const attachment = event.message.attachment;
      if (attachment?.status !== "found") continue;
      if (attachment.kind === "video") {
        const duration = Math.min(
          event.mediaDuration ?? this.media.getVideoDuration(attachment.archivePath) ?? 0,
          this.media.getVideoDuration(attachment.archivePath) ?? event.mediaDuration ?? 0,
        );
        const elapsed = clamp(time - event.at, 0, Math.max(0, duration - 0.001));
        const active = time - event.at <= duration + 0.25;
        if (active || !this.media.getVideoFrame(attachment.archivePath)) {
          promises.push(this.media.prepareVideoFrame(attachment.archivePath, elapsed, exact));
        }
      } else if (this.media.isAnimatedImage(attachment.archivePath)) {
        const cycleDuration = this.media.getPlaybackDuration(attachment.archivePath) ?? event.mediaDuration ?? 0;
        const elapsed = clamp(time - event.at, 0, Math.max(0, cycleDuration - 0.001));
        if (time - event.at <= cycleDuration + 0.25 || !this.media.getAnimatedFrame(attachment.archivePath)) {
          promises.push(this.media.prepareAnimatedFrame(attachment.archivePath, elapsed, exact));
        }
      }
    }
    await Promise.all(promises);
  }

  private drawPattern(palette: Palette, scale: number): void {
    const ctx = this.ctx;
    const { width: w, height: h } = this.canvas;
    const step = 150 * scale;
    ctx.strokeStyle = palette.pattern;
    ctx.lineWidth = 3 * scale;
    for (let y = 0; y < h; y += step) {
      for (let x = (Math.floor(y / step) % 2) * step * 0.45; x < w; x += step) {
        ctx.beginPath();
        ctx.arc(x, y, 18 * scale, 0.2, 2.1);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + 34 * scale, y + 18 * scale);
        ctx.lineTo(x + 56 * scale, y + 30 * scale);
        ctx.lineTo(x + 44 * scale, y + 48 * scale);
        ctx.stroke();
      }
    }
  }

  private drawHeader(theme: RenderTheme, palette: Palette, height: number, scale: number, timeline: CompiledTimeline, time: number): void {
    const ctx = this.ctx;
    const w = this.canvas.width;
    ctx.fillStyle = palette.header;
    ctx.fillRect(0, 0, w, height);
    const avatarX = 76 * scale;
    const avatarY = height / 2;
    ctx.fillStyle = palette.accent;
    ctx.beginPath();
    ctx.arc(avatarX, avatarY, 42 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = `500 ${30 * scale}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(initials(theme.title), avatarX, avatarY + 1 * scale);
    ctx.textAlign = "left";
    ctx.fillStyle = palette.headerText;
    ctx.font = `500 ${34 * scale}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(theme.title || "WhatsApp Replay", 138 * scale, 52 * scale);
    const count = visibleEventCount(timeline, time);
    const current = timeline.events[Math.max(0, count - 1)]?.message;
    ctx.fillStyle = palette.headerMuted;
    ctx.font = `400 ${24 * scale}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(current ? `${formatDay(current.timestamp)} · ${formatTime(current.timestamp)}` : "Chat-Replay", 138 * scale, 91 * scale);

    ctx.strokeStyle = palette.headerMuted;
    ctx.lineWidth = 4 * scale;
    for (let i = 0; i < 3; i += 1) {
      ctx.beginPath();
      ctx.arc(w - 62 * scale, (49 + i * 17) * scale, 2.5 * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private drawInputBar(palette: Palette, y: number, height: number, scale: number): void {
    const ctx = this.ctx;
    const w = this.canvas.width;
    ctx.fillStyle = palette.header;
    ctx.fillRect(0, y, w, height);
    roundedRect(ctx, 30 * scale, y + 23 * scale, w - 125 * scale, 70 * scale, 35 * scale);
    ctx.fillStyle = palette.input;
    ctx.fill();
    ctx.fillStyle = palette.headerMuted;
    ctx.font = `400 ${27 * scale}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("Nachricht", 82 * scale, y + 59 * scale);
    ctx.fillStyle = palette.accent;
    ctx.beginPath();
    ctx.arc(w - 52 * scale, y + 58 * scale, 35 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 4 * scale;
    ctx.beginPath();
    ctx.moveTo(w - 52 * scale, y + 45 * scale);
    ctx.lineTo(w - 52 * scale, y + 66 * scale);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(w - 52 * scale, y + 58 * scale, 12 * scale, 0, Math.PI);
    ctx.stroke();
  }

  private wrapText(text: string, maxWidth: number, font: string): string[] {
    const ctx = this.ctx;
    ctx.font = font;
    if (!text) return [];
    const result: string[] = [];
    for (const paragraph of text.split("\n")) {
      if (!paragraph) {
        result.push("");
        continue;
      }
      const tokens = paragraph.split(/(\s+)/u).filter((token) => token.length > 0);
      let line = "";
      for (const token of tokens) {
        const candidate = line + token;
        if (ctx.measureText(candidate).width <= maxWidth || !line.trim()) {
          line = candidate;
        } else {
          result.push(line.trimEnd());
          line = token.trimStart();
        }
        if (ctx.measureText(line).width > maxWidth) {
          let chunk = "";
          for (const character of graphemes(line)) {
            if (ctx.measureText(chunk + character).width > maxWidth && chunk) {
              result.push(chunk);
              chunk = character;
            } else chunk += character;
          }
          line = chunk;
        }
      }
      result.push(line.trimEnd());
    }
    return result;
  }

  private layoutMessage(message: ChatMessage, theme: RenderTheme, scale: number, previous?: ChatMessage): BubbleLayout {
    const ctx = this.ctx;
    const maxWidth = 760 * scale;
    const font = `400 ${30 * scale}px system-ui, -apple-system, "Segoe UI Emoji", sans-serif`;
    const card = messageCardPresentation(message);
    const firstGroupItem = isFirstAttachmentGroupItem(message);
    const showTimestamp = shouldShowMessageTimestamp(message);
    const caption = firstGroupItem ? (card ? card.body ?? "" : cleanMediaCaption(message)) : "";
    const lines = this.wrapText(caption, maxWidth - 54 * scale, font);
    const quoteLines = this.wrapText(firstGroupItem ? message.quotedText ?? "" : "", maxWidth - 92 * scale, `400 ${24 * scale}px system-ui, -apple-system, "Segoe UI Emoji", sans-serif`);
    const label = senderLabel(message, theme, this.participants);
    ctx.font = font;
    const textWidth = Math.max(0, ...lines.map((line) => ctx.measureText(line || " ").width));
    ctx.font = `500 ${23 * scale}px system-ui, -apple-system, sans-serif`;
    const senderWidth = label ? ctx.measureText(label).width : 0;
    const visualDimensions = message.attachment?.status === "found"
      ? this.media.getMediaDimensions(message.attachment.archivePath)
      : undefined;
    const hasVisual = Boolean(visualDimensions) && ["image", "sticker", "video"].includes(message.attachment?.kind ?? "");
    const hasAttachment = Boolean(message.attachment);
    let mediaWidth = 0;
    let mediaHeight = 0;
    if (!hasVisual && hasAttachment) {
      mediaWidth = 582 * scale;
      mediaHeight = /\.(?:vcf|vcard)$/iu.test(message.attachment?.displayName ?? "") ? 132 * scale : 92 * scale;
    }
    const cardWidth = card ? 620 * scale : 0;
    const cardDetailLines = card
      ? this.wrapText(card.detail ?? "", cardWidth - 112 * scale, `400 ${22 * scale}px system-ui, -apple-system, "Segoe UI Emoji", sans-serif`)
      : [];
    const cardItemLines = card
      ? card.items.map((item) => this.wrapText(item, cardWidth - 80 * scale, `400 ${23 * scale}px system-ui, -apple-system, "Segoe UI Emoji", sans-serif`))
      : [];
    const cardItemHeights = cardItemLines.map((itemLines) => Math.max(42 * scale, itemLines.length * 28 * scale + 14 * scale));
    const cardHeaderHeight = card ? Math.max(74 * scale, 56 * scale + cardDetailLines.length * 27 * scale) : 0;
    const cardHeight = card ? cardHeaderHeight + cardItemHeights.reduce((sum, itemHeight) => sum + itemHeight + 8 * scale, 0) + 16 * scale : 0;
    const senderHeight = label ? 34 * scale : 0;
    const forwardedHeight = forwardedPresentationLabel(message) ? 29 * scale : 0;
    const quoteHeight = quoteLines.length ? quoteLines.length * 31 * scale + 26 * scale : 0;
    const textHeight = lines.length ? lines.length * 39 * scale + 8 * scale : 0;
    const cardSpacing = cardHeight ? 12 * scale : 0;
    const quoteSpacing = quoteHeight ? 10 * scale : 0;
    const footerHeight = showTimestamp ? 35 * scale : 4 * scale;
    if (hasVisual && message.attachment) {
      const dimensions = visualDimensions ?? { width: 16, height: 9 };
      const chatViewportHeight = Math.max(280 * scale, this.canvas.height - 298 * scale);
      const nonMediaHeight = 28 * scale + senderHeight + forwardedHeight + quoteHeight + quoteSpacing
        + cardHeight + cardSpacing + textHeight + footerHeight + 12 * scale;
      const maxVisualHeight = Math.max(120 * scale, Math.min(610 * scale, chatViewportHeight - nonMediaHeight));
      const roleMaxWidth = message.mediaRole === "sticker" ? 330 * scale : message.mediaRole === "video-note" ? 430 * scale : 690 * scale;
      const roleMaxHeight = message.mediaRole === "sticker" ? Math.min(maxVisualHeight, 330 * scale) : maxVisualHeight;
      const fitted = fitMediaBox(dimensions.width, dimensions.height, roleMaxWidth, roleMaxHeight);
      mediaWidth = fitted.width;
      mediaHeight = fitted.height;
    }
    const baseWidth = Math.max(
      190 * scale,
      mediaWidth ? mediaWidth + 28 * scale : 0,
      cardWidth ? cardWidth + 28 * scale : 0,
      textWidth + 58 * scale,
      senderWidth + 58 * scale,
    );
    const width = Math.min(maxWidth, baseWidth);
    const mediaSpacing = mediaHeight ? 12 * scale : 0;
    const height = 28 * scale + senderHeight + forwardedHeight + quoteHeight + quoteSpacing + cardHeight + cardSpacing + mediaHeight + mediaSpacing + textHeight + footerHeight;
    const dateLabel = !previous || dayKey(previous.timestamp) !== dayKey(message.timestamp) ? formatDay(message.timestamp) : undefined;
    return {
      message,
      lines,
      quoteLines,
      senderLabel: label,
      width,
      height,
      mediaWidth,
      mediaHeight,
      card,
      cardDetailLines,
      cardItemLines,
      cardItemHeights,
      cardWidth,
      cardHeight,
      dateLabel,
    };
  }

  private drawMessages(timeline: CompiledTimeline, time: number, theme: RenderTheme, palette: Palette, bottom: number, scale: number): void {
    const visibleCount = visibleEventCount(timeline, time);
    if (!visibleCount) return;
    const start = Math.max(0, visibleCount - 90);
    const events = timeline.events.slice(start, visibleCount);
    const layouts = events.map((event, index) => this.layoutMessage(
      event.message,
      theme,
      scale,
      timeline.events[start + index - 1]?.message,
    ));
    const gaps = layouts.map((layout, index) => messageGapAfter(
      layout.message,
      timeline.events[start + index + 1]?.message,
      scale,
    ));
    const dateHeight = 66 * scale;
    const total = layouts.reduce((sum, layout, index) => sum + layout.height + (gaps[index] ?? 15 * scale) + (layout.dateLabel ? dateHeight : 0), 0);
    // Anchor the newest message above the composer. When the chat is taller than
    // the viewport, older bubbles deliberately move above the clipping region.
    let y = bottom - 24 * scale - total;
    const latestLayout = layouts[layouts.length - 1];
    const latestEvent = events[events.length - 1];
    if (latestLayout && latestEvent) {
      const latestEntryHeight = latestLayout.height + (gaps[gaps.length - 1] ?? 15 * scale) + (latestLayout.dateLabel ? dateHeight : 0);
      const availableHeight = Math.max(120 * scale, bottom - 132 * scale - 48 * scale);
      const nextEventAt = timeline.events[visibleCount]?.at ?? timeline.duration;
      y += oversizedBubbleScrollOffset(
        latestEntryHeight,
        availableHeight,
        time - latestEvent.at,
        nextEventAt - latestEvent.at,
      );
    }
    const w = this.canvas.width;

    layouts.forEach((layout, index) => {
      const event = events[index];
      if (!event) return;
      if (layout.dateLabel) {
        const chipWidth = 245 * scale;
        roundedRect(this.ctx, (w - chipWidth) / 2, y + 9 * scale, chipWidth, 44 * scale, 16 * scale);
        this.ctx.fillStyle = palette.system;
        this.ctx.fill();
        this.ctx.fillStyle = palette.mutedText;
        this.ctx.font = `500 ${19 * scale}px system-ui, -apple-system, sans-serif`;
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "middle";
        this.ctx.fillText(layout.dateLabel, w / 2, y + 31 * scale);
        y += dateHeight;
      }
      const progress = easeOut((time - event.at) / event.revealDuration);
      const translatedY = y + (1 - progress) * 28 * scale;
      this.ctx.save();
      this.ctx.globalAlpha = progress;
      this.drawBubble(layout, theme, palette, translatedY, scale);
      this.ctx.restore();
      y += layout.height + (gaps[index] ?? 15 * scale);
    });
  }

  private drawBubble(layout: BubbleLayout, theme: RenderTheme, palette: Palette, y: number, scale: number): void {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const isSystem = !layout.message.sender;
    const mine = layout.message.sender === theme.selfName;
    const width = isSystem ? Math.min(720 * scale, layout.width) : layout.width;
    const x = isSystem ? (w - width) / 2 : mine ? w - 34 * scale - width : 34 * scale;
    const stickerPath = layout.message.attachment?.archivePath;
    const transparentSticker = layout.message.mediaRole === "sticker"
      && layout.message.attachment?.status === "found"
      && Boolean(stickerPath && this.media.getMediaDimensions(stickerPath));
    const bareSticker = transparentSticker
      && layout.mediaHeight > 0
      && !layout.card
      && !layout.lines.length
      && !layout.quoteLines.length
      && !forwardedPresentationLabel(layout.message);
    if (!bareSticker) {
      roundedRect(ctx, x, y, width, layout.height, 20 * scale);
      ctx.fillStyle = isSystem ? palette.system : mine ? palette.outgoing : palette.incoming;
      ctx.fill();
    }
    let cursorY = y + 23 * scale;
    if (layout.senderLabel) {
      ctx.fillStyle = palette.accent;
      ctx.font = `500 ${23 * scale}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(layout.senderLabel, x + 27 * scale, cursorY);
      cursorY += 34 * scale;
    }
    const forwardedLabel = forwardedPresentationLabel(layout.message);
    if (forwardedLabel) {
      ctx.fillStyle = palette.mutedText;
      ctx.font = `500 ${20 * scale}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(forwardedLabel, x + 27 * scale, cursorY);
      cursorY += 29 * scale;
    }
    if (layout.quoteLines.length) {
      const quoteHeight = layout.quoteLines.length * 31 * scale + 26 * scale;
      this.drawQuoteBlock(layout.quoteLines, x + 18 * scale, cursorY, width - 36 * scale, quoteHeight, palette, scale);
      cursorY += quoteHeight + 10 * scale;
    }
    if (layout.card && layout.cardHeight > 0) {
      const cardX = x + (width - layout.cardWidth) / 2;
      this.drawSpecialCard(layout, cardX, cursorY, layout.cardWidth, layout.cardHeight, palette, scale);
      cursorY += layout.cardHeight + 12 * scale;
    }
    if (layout.mediaHeight > 0) {
      const mediaX = x + (width - layout.mediaWidth) / 2;
      this.drawMedia(layout, mediaX, cursorY, layout.mediaWidth, layout.mediaHeight, palette, scale);
      cursorY += layout.mediaHeight + 12 * scale;
    }
    if (layout.lines.length) this.drawTextLines(layout.lines, x + 27 * scale, cursorY, width - 54 * scale, palette, scale, isSystem && !layout.card);
    if (isSystem || !shouldShowMessageTimestamp(layout.message)) return;
    const timeLabel = `${layout.message.edited ? "BEARBEITET · " : ""}${formatTime(layout.message.timestamp)}`;
    if (bareSticker) {
      ctx.font = `500 ${19 * scale}px system-ui, -apple-system, sans-serif`;
      const chipWidth = ctx.measureText(timeLabel).width + 20 * scale;
      roundedRect(ctx, x + width - chipWidth - 10 * scale, y + layout.height - 37 * scale, chipWidth, 28 * scale, 9 * scale);
      ctx.fillStyle = "rgba(0, 0, 0, .55)";
      ctx.fill();
    }
    ctx.fillStyle = bareSticker ? "#ffffff" : palette.mutedText;
    ctx.font = `400 ${19 * scale}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText(timeLabel, x + width - 20 * scale, y + layout.height - 12 * scale);
  }

  private drawQuoteBlock(
    lines: string[],
    x: number,
    y: number,
    width: number,
    height: number,
    palette: Palette,
    scale: number,
  ): void {
    const ctx = this.ctx;
    roundedRect(ctx, x, y, width, height, 12 * scale);
    ctx.fillStyle = palette.media;
    ctx.fill();
    ctx.fillStyle = palette.accent;
    ctx.fillRect(x, y, 6 * scale, height);
    ctx.fillStyle = palette.mutedText;
    ctx.font = `500 ${18 * scale}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("ZITAT", x + 20 * scale, y + 9 * scale);
    ctx.fillStyle = palette.text;
    ctx.font = `400 ${24 * scale}px system-ui, -apple-system, "Segoe UI Emoji", sans-serif`;
    lines.forEach((line, index) => ctx.fillText(line, x + 20 * scale, y + 34 * scale + index * 31 * scale));
  }

  private drawSpecialCard(
    layout: BubbleLayout,
    x: number,
    y: number,
    width: number,
    height: number,
    palette: Palette,
    scale: number,
  ): void {
    const card = layout.card;
    if (!card) return;
    const ctx = this.ctx;
    roundedRect(ctx, x, y, width, height, 15 * scale);
    ctx.fillStyle = palette.media;
    ctx.fill();
    ctx.fillStyle = card.accent;
    ctx.beginPath();
    ctx.arc(x + 38 * scale, y + 36 * scale, 23 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = `600 ${25 * scale}px system-ui, -apple-system, "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(card.icon, x + 38 * scale, y + 36 * scale);
    ctx.fillStyle = palette.text;
    ctx.font = `600 ${26 * scale}px system-ui, -apple-system, "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(card.title, x + 76 * scale, y + 14 * scale);
    ctx.fillStyle = palette.mutedText;
    ctx.font = `400 ${22 * scale}px system-ui, -apple-system, "Segoe UI Emoji", sans-serif`;
    layout.cardDetailLines.forEach((line, index) => ctx.fillText(line, x + 76 * scale, y + 45 * scale + index * 27 * scale));

    let itemY = y + Math.max(74 * scale, 56 * scale + layout.cardDetailLines.length * 27 * scale);
    layout.cardItemLines.forEach((itemLines, index) => {
      const itemHeight = layout.cardItemHeights[index] ?? 42 * scale;
      roundedRect(ctx, x + 18 * scale, itemY, width - 36 * scale, itemHeight, 10 * scale);
      ctx.fillStyle = palette.input;
      ctx.fill();
      ctx.fillStyle = card.accent;
      ctx.beginPath();
      ctx.arc(x + 37 * scale, itemY + itemHeight / 2, 6 * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = palette.text;
      ctx.font = `400 ${23 * scale}px system-ui, -apple-system, "Segoe UI Emoji", sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      const textY = itemY + (itemHeight - itemLines.length * 28 * scale) / 2;
      itemLines.forEach((line, lineIndex) => ctx.fillText(line, x + 55 * scale, textY + lineIndex * 28 * scale));
      itemY += itemHeight + 8 * scale;
    });
  }

  private drawTextLines(lines: string[], x: number, y: number, _width: number, palette: Palette, scale: number, centered: boolean): void {
    const ctx = this.ctx;
    ctx.fillStyle = palette.text;
    ctx.font = `400 ${30 * scale}px system-ui, -apple-system, "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = centered ? "center" : "left";
    ctx.textBaseline = "top";
    const drawX = centered ? this.canvas.width / 2 : x;
    lines.forEach((line, index) => ctx.fillText(line, drawX, y + index * 39 * scale));
  }

  private drawMedia(layout: BubbleLayout, x: number, y: number, width: number, height: number, palette: Palette, scale: number): void {
    const ctx = this.ctx;
    const attachment = layout.message.attachment;
    const circularVideoNote = shouldRenderCircularVideoNote(layout.message.mediaRole, width, height);
    if (circularVideoNote) {
      ctx.beginPath();
      ctx.arc(x + width / 2, y + height / 2, Math.min(width, height) / 2, 0, Math.PI * 2);
    } else {
      roundedRect(ctx, x, y, width, height, 14 * scale);
    }
    ctx.save();
    ctx.clip();
    const transparentSticker = layout.message.mediaRole === "sticker"
      && attachment?.status === "found"
      && Boolean(attachment.archivePath && this.media.getMediaDimensions(attachment.archivePath));
    if (!transparentSticker) {
      ctx.fillStyle = palette.media;
      ctx.fillRect(x, y, width, height);
    }
    const image = attachment?.archivePath ? this.media.getImage(attachment.archivePath) : undefined;
    const animatedFrame = attachment?.archivePath ? this.media.getAnimatedFrame(attachment.archivePath) : undefined;
    const videoFrame = attachment?.kind === "video" && attachment.archivePath
      ? this.media.getVideoFrame(attachment.archivePath)
      : undefined;
    const hasVideoTrack = attachment?.kind === "video" && attachment.archivePath
      ? this.media.getVideoDuration(attachment.archivePath) !== undefined
      : false;
    const audioClip = (attachment?.kind === "audio" || (attachment?.kind === "video" && !hasVideoTrack)) && attachment.archivePath
      ? this.media.getAudioInfo(attachment.archivePath)
      : undefined;
    const contactCard = attachment?.archivePath ? this.media.getContactCard(attachment.archivePath) : undefined;
    if (contactCard) {
      this.drawContactMedia(contactCard, x, y, width, height, palette, scale);
    } else if (audioClip) {
      this.drawAudioMedia(layout, audioClip, x, y, width, height, palette, scale);
    } else if (animatedFrame) {
      ctx.drawImage(animatedFrame, x, y, width, height);
    } else if (image) {
      ctx.drawImage(image, x, y, width, height);
    } else if (videoFrame) {
      videoFrame.draw(ctx, x, y, width, height);
      const eventAt = this.eventTimes.get(layout.message.id) ?? this.currentTime;
      const clipDuration = this.media.getVideoDuration(attachment?.archivePath ?? "")
        ?? this.eventDurations.get(layout.message.id)
        ?? 0;
      const elapsed = clamp(this.currentTime - eventAt, 0, clipDuration);
      const progress = clipDuration > 0 ? elapsed / clipDuration : 0;
      ctx.fillStyle = "rgba(0, 0, 0, .28)";
      ctx.fillRect(x, y + height - 38 * scale, width, 38 * scale);
      ctx.fillStyle = "rgba(255, 255, 255, .42)";
      ctx.fillRect(x + 16 * scale, y + height - 17 * scale, width - 32 * scale, 4 * scale);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x + 16 * scale, y + height - 17 * scale, (width - 32 * scale) * progress, 4 * scale);
      ctx.font = `500 ${18 * scale}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const videoLabel = layout.message.mediaRole === "video-note" ? "VIDEONOTIZ" : layout.message.mediaRole === "animated-image" ? "GIF" : "VIDEO";
      ctx.fillText(`${videoLabel} · ${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, "0")}`, x + 16 * scale, y + height - 27 * scale);
    } else {
      const card = attachmentCardPresentation(layout.message) ?? { icon: "▧", title: "MEDIUM", detail: attachment?.displayName ?? "Medium" };
      const accent = attachment?.status === "missing" ? "#d86b65" : attachment?.status === "ambiguous" ? "#d97706" : palette.accent;
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(x + 44 * scale, y + height / 2, 28 * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = `600 ${27 * scale}px system-ui, -apple-system, "Segoe UI Emoji", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(card.icon, x + 44 * scale, y + height / 2);
      ctx.fillStyle = palette.text;
      ctx.font = `600 ${21 * scale}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(card.title, x + 86 * scale, y + 20 * scale, width - 105 * scale);
      ctx.fillStyle = palette.mutedText;
      ctx.font = `400 ${20 * scale}px system-ui, -apple-system, "Segoe UI Emoji", sans-serif`;
      ctx.fillText(card.detail, x + 86 * scale, y + 50 * scale, width - 105 * scale);
    }
    const groupIndex = attachmentGroupIndexLabel(layout.message);
    if (groupIndex) {
      ctx.font = `600 ${17 * scale}px system-ui, -apple-system, sans-serif`;
      const chipWidth = Math.max(43 * scale, ctx.measureText(groupIndex).width + 18 * scale);
      const chipHeight = 27 * scale;
      const chipX = circularVideoNote ? x + (width - chipWidth) / 2 : x + width - chipWidth - 10 * scale;
      const chipY = y + (circularVideoNote ? 20 : 10) * scale;
      roundedRect(ctx, chipX, chipY, chipWidth, chipHeight, 10 * scale);
      ctx.fillStyle = "rgba(0, 0, 0, .58)";
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(groupIndex, chipX + chipWidth / 2, chipY + chipHeight / 2 + 0.5 * scale);
    }
    ctx.restore();
  }

  private drawContactMedia(
    contact: ContactCardInfo,
    x: number,
    y: number,
    width: number,
    height: number,
    palette: Palette,
    scale: number,
  ): void {
    const ctx = this.ctx;
    const firstContactName = contact.name.replace(/\s+/gu, " ").trim();
    const contactCount = 1 + (contact.additionalContacts ?? 0);
    const cleanName = contactCount > 1 ? `${contactCount} Kontakte` : firstContactName;
    const previewNames = [firstContactName, ...(contact.additionalContactNames ?? [])].slice(0, 2);
    const hiddenNames = Math.max(0, contactCount - previewNames.length);
    const addresses = contact.addresses ?? [];
    const urls = contact.urls ?? [];
    const detail = contactCount > 1
      ? `${previewNames.join(" · ")}${hiddenNames ? ` · +${hiddenNames}` : ""}`
      : contact.organization?.replace(/\s+/gu, " ").trim()
      || contact.phones[0]
      || contact.emails[0]
      || addresses[0]
      || urls[0]
      || contact.birthday
      || contact.note?.replace(/\s+/gu, " ").trim()
      || "Geteilter Kontakt";
    const metadataParts = [
      contact.phones.length ? `${contact.phones.length} TEL` : "",
      contact.emails.length ? `${contact.emails.length} E-MAIL` : "",
      addresses.length ? `${addresses.length} ADRESSE${addresses.length === 1 ? "" : "N"}` : "",
      urls.length ? `${urls.length} LINK${urls.length === 1 ? "" : "S"}` : "",
      contact.birthday ? "GEBURTSTAG" : "",
      contact.note ? "NOTIZ" : "",
    ].filter(Boolean);
    const contactMetadata = contactCount > 1
      ? `${contactCount} KONTAKTE · MEHRFACHKARTE`
      : metadataParts.length
        ? metadataParts.join(" · ")
        : "KONTAKT";
    ctx.fillStyle = palette.accent;
    ctx.beginPath();
    ctx.arc(x + 56 * scale, y + height / 2, 38 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = `600 ${24 * scale}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(initials(cleanName), x + 56 * scale, y + height / 2);
    ctx.fillStyle = palette.text;
    ctx.font = `600 ${25 * scale}px system-ui, -apple-system, "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(cleanName, x + 112 * scale, y + 23 * scale, width - 132 * scale);
    ctx.fillStyle = palette.mutedText;
    ctx.font = `400 ${21 * scale}px system-ui, -apple-system, "Segoe UI Emoji", sans-serif`;
    ctx.fillText(detail, x + 112 * scale, y + 58 * scale, width - 132 * scale);
    ctx.font = `500 ${18 * scale}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(contactMetadata, x + 112 * scale, y + 91 * scale, width - 132 * scale);
  }

  private drawAudioMedia(
    layout: BubbleLayout,
    clip: AudioMediaInfo,
    x: number,
    y: number,
    width: number,
    height: number,
    palette: Palette,
    scale: number,
  ): void {
    const ctx = this.ctx;
    const eventAt = this.eventTimes.get(layout.message.id) ?? this.currentTime;
    const elapsed = clamp(this.currentTime - eventAt, 0, clip.duration);
    const progress = clip.duration > 0 ? elapsed / clip.duration : 0;
    const active = this.currentTime >= eventAt && this.currentTime < eventAt + clip.duration;
    const buttonX = x + 45 * scale;
    const middleY = y + height / 2;
    ctx.fillStyle = palette.accent;
    ctx.beginPath();
    ctx.arc(buttonX, middleY, 29 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = `600 ${21 * scale}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(active ? "Ⅱ" : "▶", buttonX + (active ? 0 : 2 * scale), middleY);

    const waveformX = x + 88 * scale;
    const waveformWidth = Math.max(80 * scale, width - 184 * scale);
    const barStep = waveformWidth / clip.peaks.length;
    clip.peaks.forEach((peak, index) => {
      const barProgress = (index + 0.5) / clip.peaks.length;
      const barHeight = Math.max(5 * scale, peak * 45 * scale);
      ctx.fillStyle = barProgress <= progress ? palette.accent : palette.mutedText;
      ctx.fillRect(waveformX + index * barStep, middleY - barHeight / 2, Math.max(2 * scale, barStep * 0.42), barHeight);
    });

    ctx.fillStyle = palette.mutedText;
    ctx.font = `600 ${14 * scale}px system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(layout.message.mediaRole === "voice-note" ? "SPRACHNACHRICHT" : "AUDIO", waveformX, y + 7 * scale);
    ctx.font = `500 ${18 * scale}px system-ui, sans-serif`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(`${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, "0")}`, x + width - 18 * scale, middleY);
  }
}
