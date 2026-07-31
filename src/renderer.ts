import { ALL_FORMATS, AudioBufferSink, BlobSource, Input, VideoSample, VideoSampleSink } from "mediabunny";
import { hasExplicitGroupEvidence, messageDirection, sameParticipant } from "./identity";
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
  sequence: MessageSequencePosition;
  timestampInline: boolean;
  timestampOverlay: boolean;
  topPadding: number;
  bottomPadding: number;
}

export interface RenderMetrics {
  scale: number;
  contentX: number;
  contentWidth: number;
  headerHeight: number;
  composerHeight: number;
  bubbleMaxWidth: number;
  sidePadding: number;
}

export type MessageSequencePosition = "single" | "first" | "middle" | "last";

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

export function computeRenderMetrics(width: number, height: number): RenderMetrics {
  const landscape = width / Math.max(1, height) >= 1.25;
  const square = width / Math.max(1, height) >= 0.85;
  const contentWidth = landscape ? Math.min(width, height * 1.06) : width;
  const scale = Math.max(0.1, landscape || square
    ? Math.min(contentWidth / 1080, height / 1080)
    : Math.min(contentWidth / 720, height / 1280));
  const chromeFactor = landscape ? 0.78 : 1;
  return {
    scale,
    contentX: (width - contentWidth) / 2,
    contentWidth,
    headerHeight: 114 * scale * chromeFactor,
    composerHeight: 106 * scale * chromeFactor,
    bubbleMaxWidth: Math.min(760 * scale, contentWidth * 0.76),
    sidePadding: 28 * scale,
  };
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
  if (messagesShareAttachmentGroup(current, next)) return 4 * scale;
  return (messagesShareSequence(current, next) ? 4 : 14) * scale;
}

export function messagesShareSequence(current: ChatMessage | undefined, next: ChatMessage | undefined): boolean {
  if (!current?.sender || !next?.sender || !sameParticipant(current.sender, next.sender)) return false;
  if (dayKey(current.timestamp) !== dayKey(next.timestamp)) return false;
  const elapsed = next.timestamp.getTime() - current.timestamp.getTime();
  return elapsed >= 0 && elapsed <= 5 * 60 * 1000;
}

export function messageSequencePosition(
  previous: ChatMessage | undefined,
  current: ChatMessage,
  next: ChatMessage | undefined,
): MessageSequencePosition {
  if (!current.sender) return "single";
  const joinsPrevious = messagesShareSequence(previous, current);
  const joinsNext = messagesShareSequence(current, next);
  if (joinsPrevious && joinsNext) return "middle";
  if (joinsPrevious) return "last";
  if (joinsNext) return "first";
  return "single";
}

export function shouldShowMessageTimestamp(message: ChatMessage): boolean {
  return isLastAttachmentGroupItem(message);
}

export function forwardedPresentationLabel(message: ChatMessage): string | undefined {
  if (!isFirstAttachmentGroupItem(message)) return undefined;
  if (message.frequentlyForwarded) return "Häufig weitergeleitet";
  return message.forwarded ? "Weitergeleitet" : undefined;
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
  headerDivider: string;
  headerText: string;
  headerMuted: string;
  incoming: string;
  outgoing: string;
  text: string;
  mutedText: string;
  outgoingMuted: string;
  system: string;
  input: string;
  accent: string;
  media: string;
  senderColors: string[];
}

const LIGHT: Palette = {
  background: "#efeae2",
  pattern: "rgba(92, 88, 81, .095)",
  header: "#f0f2f5",
  headerDivider: "rgba(17, 27, 33, .08)",
  headerText: "#111b21",
  headerMuted: "#667781",
  incoming: "#ffffff",
  outgoing: "#d9fdd3",
  text: "#111b21",
  mutedText: "#667781",
  outgoingMuted: "#5f7669",
  system: "#ffffffd9",
  input: "#ffffff",
  accent: "#00a884",
  media: "#d9e1e5",
  senderColors: ["#007bfc", "#d6409f", "#00a884", "#d97706", "#7c5ac7", "#c94b45"],
};

const DARK: Palette = {
  background: "#0b141a",
  pattern: "rgba(177, 185, 189, .07)",
  header: "#202c33",
  headerDivider: "rgba(255, 255, 255, .05)",
  headerText: "#e9edef",
  headerMuted: "#8696a0",
  incoming: "#202c33",
  outgoing: "#005c4b",
  text: "#e9edef",
  mutedText: "#8696a0",
  outgoingMuted: "#8fbab1",
  system: "#182229e8",
  input: "#202c33",
  accent: "#00a884",
  media: "#26363e",
  senderColors: ["#53bdeb", "#ff8bd4", "#06cf9c", "#ffb55f", "#c7a8ff", "#ff8a80"],
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

function roundedRectCorners(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  topLeft: number,
  topRight: number,
  bottomRight: number,
  bottomLeft: number,
): void {
  const limit = Math.min(width / 2, height / 2);
  const tl = Math.min(limit, topLeft);
  const tr = Math.min(limit, topRight);
  const br = Math.min(limit, bottomRight);
  const bl = Math.min(limit, bottomLeft);
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + width - tr, y);
  ctx.arcTo(x + width, y, x + width, y + tr, tr);
  ctx.lineTo(x + width, y + height - br);
  ctx.arcTo(x + width, y + height, x + width - br, y + height, br);
  ctx.lineTo(x + bl, y + height);
  ctx.arcTo(x, y + height, x, y + height - bl, bl);
  ctx.lineTo(x, y + tl);
  ctx.arcTo(x, y, x + tl, y, tl);
  ctx.closePath();
}

function ellipsizeText(ctx: CanvasRenderingContext2D, value: string, maxWidth: number): string {
  if (ctx.measureText(value).width <= maxWidth) return value;
  const suffix = "…";
  let output = "";
  for (const character of graphemes(value)) {
    if (ctx.measureText(output + character + suffix).width > maxWidth) break;
    output += character;
  }
  return output ? output + suffix : suffix;
}

function initials(value: string): string {
  const parts = value.trim().split(/\s+/u).filter(Boolean);
  return (parts.slice(0, 2).map((part) => part[0]?.toLocaleUpperCase() ?? "").join("") || "WA").slice(0, 2);
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatDay(date: Date): string {
  return new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
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

function senderLabel(
  message: ChatMessage,
  theme: RenderTheme,
  participants: string[],
  groupChat: boolean,
  sequence: MessageSequencePosition,
): string {
  if (!groupChat || !isFirstAttachmentGroupItem(message) || !["single", "first"].includes(sequence)) return "";
  if (!message.sender || messageDirection(message, theme.selfName) === "outgoing") return "";
  return theme.anonymize ? pseudonym(message.sender, participants) : message.sender;
}

function senderColor(sender: string, participants: string[], palette: Palette): string {
  const index = Math.max(0, participants.findIndex((participant) => sameParticipant(participant, sender)));
  return palette.senderColors[index % palette.senderColors.length] ?? palette.accent;
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
  private groupChat = false;

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
    this.groupChat = this.participants.length > 2
      || hasExplicitGroupEvidence(timeline.events.map((event) => event.message));
    this.currentTime = time;
    const ctx = this.ctx;
    const { width: w, height: h } = this.canvas;
    const metrics = computeRenderMetrics(w, h);
    const palette = theme.mode === "dark" ? DARK : LIGHT;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, w, h);
    this.drawPattern(palette, metrics.scale);

    this.drawHeader(theme, palette, metrics);
    this.drawInputBar(palette, h - metrics.composerHeight, metrics);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, metrics.headerHeight, w, h - metrics.headerHeight - metrics.composerHeight);
    ctx.clip();
    this.drawMessages(timeline, time, theme, palette, h - metrics.composerHeight, metrics);
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
    const step = 180 * scale;
    ctx.strokeStyle = palette.pattern;
    ctx.lineWidth = 1.65 * scale;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let row = 0, y = 34 * scale; y < h; row += 1, y += step) {
      for (let column = 0, x = 28 * scale + (row % 2) * step * 0.47; x < w; column += 1, x += step) {
        const variant = (row * 3 + column * 5) % 6;
        if (variant === 0) {
          roundedRect(ctx, x, y, 46 * scale, 32 * scale, 8 * scale);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(x + 9 * scale, y + 31 * scale);
          ctx.lineTo(x + 4 * scale, y + 40 * scale);
          ctx.lineTo(x + 18 * scale, y + 33 * scale);
          ctx.stroke();
        } else if (variant === 1) {
          roundedRect(ctx, x, y + 4 * scale, 45 * scale, 32 * scale, 7 * scale);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(x + 22 * scale, y + 20 * scale, 8 * scale, 0, Math.PI * 2);
          ctx.stroke();
        } else if (variant === 2) {
          ctx.beginPath();
          ctx.arc(x + 20 * scale, y + 20 * scale, 18 * scale, 0, Math.PI * 2);
          ctx.moveTo(x + 13 * scale, y + 15 * scale);
          ctx.arc(x + 13 * scale, y + 15 * scale, 1.3 * scale, 0, Math.PI * 2);
          ctx.moveTo(x + 27 * scale, y + 15 * scale);
          ctx.arc(x + 27 * scale, y + 15 * scale, 1.3 * scale, 0, Math.PI * 2);
          ctx.moveTo(x + 10 * scale, y + 22 * scale);
          ctx.arc(x + 20 * scale, y + 21 * scale, 10 * scale, 0.15, Math.PI - 0.15);
          ctx.stroke();
        } else if (variant === 3) {
          ctx.beginPath();
          for (let point = 0; point < 10; point += 1) {
            const angle = -Math.PI / 2 + point * Math.PI / 5;
            const radius = (point % 2 === 0 ? 19 : 8) * scale;
            const px = x + 20 * scale + Math.cos(angle) * radius;
            const py = y + 20 * scale + Math.sin(angle) * radius;
            if (point === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.stroke();
        } else if (variant === 4) {
          ctx.beginPath();
          ctx.moveTo(x, y + 9 * scale);
          ctx.lineTo(x + 43 * scale, y + 20 * scale);
          ctx.lineTo(x + 4 * scale, y + 36 * scale);
          ctx.lineTo(x + 13 * scale, y + 22 * scale);
          ctx.closePath();
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(x + 14 * scale, y + 15 * scale, 10 * scale, Math.PI, 0);
          ctx.arc(x + 30 * scale, y + 15 * scale, 10 * scale, Math.PI, 0);
          ctx.lineTo(x + 22 * scale, y + 38 * scale);
          ctx.lineTo(x + 5 * scale, y + 16 * scale);
          ctx.stroke();
        }
      }
    }
  }

  private drawHeader(theme: RenderTheme, palette: Palette, metrics: RenderMetrics): void {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const { contentX, contentWidth, headerHeight: height, scale } = metrics;
    const right = contentX + contentWidth;
    ctx.fillStyle = palette.header;
    ctx.fillRect(0, 0, w, height);
    ctx.fillStyle = palette.headerDivider;
    ctx.fillRect(0, height - Math.max(1, scale), w, Math.max(1, scale));

    const avatarX = contentX + 79 * scale;
    const avatarY = height / 2;
    this.drawBackIcon(contentX + 28 * scale, avatarY, palette.headerMuted, scale);
    ctx.fillStyle = palette.accent;
    ctx.beginPath();
    ctx.arc(avatarX, avatarY, 35 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = `600 ${23 * scale}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(initials(theme.title), avatarX, avatarY + 1 * scale);

    const videoX = right - 136 * scale;
    const phoneX = right - 86 * scale;
    const menuX = right - 35 * scale;
    const titleX = contentX + 128 * scale;
    const titleMaxWidth = Math.max(80 * scale, videoX - titleX - 24 * scale);
    const subtitle = this.groupChat
      ? this.participants
        .filter((participant) => theme.selfName !== participant)
        .slice(0, 4)
        .map((participant) => theme.anonymize ? pseudonym(participant, this.participants) : participant)
        .join(", ")
      : "";
    ctx.textAlign = "left";
    ctx.fillStyle = palette.headerText;
    ctx.font = `600 ${30 * scale}px system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.fillText(ellipsizeText(ctx, theme.title || "WhatsApp Replay", titleMaxWidth), titleX, subtitle ? height * 0.39 : height * 0.52);
    if (subtitle) {
      ctx.fillStyle = palette.headerMuted;
      ctx.font = `400 ${18 * scale}px system-ui, -apple-system, sans-serif`;
      ctx.fillText(ellipsizeText(ctx, subtitle, titleMaxWidth), titleX, height * 0.7);
    }
    this.drawVideoCallIcon(videoX, avatarY, palette.headerMuted, scale);
    this.drawPhoneIcon(phoneX, avatarY, palette.headerMuted, scale);
    this.drawMenuIcon(menuX, avatarY, palette.headerMuted, scale);
  }

  private drawInputBar(palette: Palette, y: number, metrics: RenderMetrics): void {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const { contentX, contentWidth, composerHeight: height, scale } = metrics;
    const right = contentX + contentWidth;
    const centerY = y + height / 2;
    ctx.fillStyle = palette.header;
    ctx.fillRect(0, y, w, height);
    const plusX = contentX + 31 * scale;
    const micX = right - 32 * scale;
    const inputX = contentX + 62 * scale;
    const inputRight = micX - 47 * scale;
    roundedRect(ctx, inputX, centerY - 33 * scale, inputRight - inputX, 66 * scale, 33 * scale);
    ctx.fillStyle = palette.input;
    ctx.fill();
    ctx.fillStyle = palette.headerMuted;
    ctx.font = `400 ${24 * scale}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("Nachricht", inputX + 55 * scale, centerY + 1 * scale);
    this.drawPlusIcon(plusX, centerY, palette.headerMuted, scale);
    this.drawSmileIcon(inputX + 27 * scale, centerY, palette.headerMuted, scale);
    this.drawAttachmentIcon(inputRight - 65 * scale, centerY, palette.headerMuted, scale);
    this.drawCameraIcon(inputRight - 27 * scale, centerY, palette.headerMuted, scale);
    ctx.fillStyle = palette.accent;
    ctx.beginPath();
    ctx.arc(micX, centerY, 31 * scale, 0, Math.PI * 2);
    ctx.fill();
    this.drawMicrophoneIcon(micX, centerY, "#ffffff", scale);
  }

  private prepareIcon(color: string, scale: number): void {
    this.ctx.strokeStyle = color;
    this.ctx.fillStyle = color;
    this.ctx.lineWidth = Math.max(1.5, 2.8 * scale);
    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";
  }

  private drawBackIcon(x: number, y: number, color: string, scale: number): void {
    const ctx = this.ctx;
    this.prepareIcon(color, scale);
    ctx.beginPath();
    ctx.moveTo(x + 8 * scale, y - 15 * scale);
    ctx.lineTo(x - 7 * scale, y);
    ctx.lineTo(x + 8 * scale, y + 15 * scale);
    ctx.moveTo(x - 6 * scale, y);
    ctx.lineTo(x + 18 * scale, y);
    ctx.stroke();
  }

  private drawVideoCallIcon(x: number, y: number, color: string, scale: number): void {
    const ctx = this.ctx;
    this.prepareIcon(color, scale);
    roundedRect(ctx, x - 16 * scale, y - 11 * scale, 24 * scale, 22 * scale, 4 * scale);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + 8 * scale, y - 6 * scale);
    ctx.lineTo(x + 19 * scale, y - 12 * scale);
    ctx.lineTo(x + 19 * scale, y + 12 * scale);
    ctx.lineTo(x + 8 * scale, y + 6 * scale);
    ctx.closePath();
    ctx.stroke();
  }

  private drawPhoneIcon(x: number, y: number, color: string, scale: number): void {
    const ctx = this.ctx;
    this.prepareIcon(color, scale);
    ctx.beginPath();
    ctx.arc(x, y, 17 * scale, 0.45, 2.68);
    ctx.moveTo(x + 15 * scale, y + 7 * scale);
    ctx.lineTo(x + 20 * scale, y + 15 * scale);
    ctx.lineTo(x + 12 * scale, y + 19 * scale);
    ctx.moveTo(x - 15 * scale, y - 7 * scale);
    ctx.lineTo(x - 20 * scale, y - 15 * scale);
    ctx.lineTo(x - 12 * scale, y - 19 * scale);
    ctx.stroke();
  }

  private drawMenuIcon(x: number, y: number, color: string, scale: number): void {
    const ctx = this.ctx;
    this.prepareIcon(color, scale);
    for (const offset of [-10, 0, 10]) {
      ctx.beginPath();
      ctx.arc(x, y + offset * scale, 2.1 * scale, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawPlusIcon(x: number, y: number, color: string, scale: number): void {
    const ctx = this.ctx;
    this.prepareIcon(color, scale);
    ctx.beginPath();
    ctx.arc(x, y, 19 * scale, 0, Math.PI * 2);
    ctx.moveTo(x - 8 * scale, y);
    ctx.lineTo(x + 8 * scale, y);
    ctx.moveTo(x, y - 8 * scale);
    ctx.lineTo(x, y + 8 * scale);
    ctx.stroke();
  }

  private drawSmileIcon(x: number, y: number, color: string, scale: number): void {
    const ctx = this.ctx;
    this.prepareIcon(color, scale);
    ctx.beginPath();
    ctx.arc(x, y, 15 * scale, 0, Math.PI * 2);
    ctx.moveTo(x - 6 * scale, y - 4 * scale);
    ctx.arc(x - 6 * scale, y - 4 * scale, 1.2 * scale, 0, Math.PI * 2);
    ctx.moveTo(x + 6 * scale, y - 4 * scale);
    ctx.arc(x + 6 * scale, y - 4 * scale, 1.2 * scale, 0, Math.PI * 2);
    ctx.moveTo(x - 7 * scale, y + 3 * scale);
    ctx.arc(x, y + 2 * scale, 8 * scale, 0.18, Math.PI - 0.18);
    ctx.stroke();
  }

  private drawAttachmentIcon(x: number, y: number, color: string, scale: number): void {
    const ctx = this.ctx;
    this.prepareIcon(color, scale);
    ctx.beginPath();
    ctx.arc(x, y, 13 * scale, 0.7, 5.3);
    ctx.arc(x, y, 8 * scale, 5.3, 0.7, true);
    ctx.stroke();
  }

  private drawCameraIcon(x: number, y: number, color: string, scale: number): void {
    const ctx = this.ctx;
    this.prepareIcon(color, scale);
    roundedRect(ctx, x - 15 * scale, y - 11 * scale, 30 * scale, 22 * scale, 5 * scale);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 6 * scale, 0, Math.PI * 2);
    ctx.stroke();
  }

  private drawMicrophoneIcon(x: number, y: number, color: string, scale: number): void {
    const ctx = this.ctx;
    this.prepareIcon(color, scale);
    roundedRect(ctx, x - 6 * scale, y - 14 * scale, 12 * scale, 22 * scale, 6 * scale);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 5 * scale, 0, Math.PI);
    ctx.moveTo(x, y + 10 * scale);
    ctx.lineTo(x, y + 17 * scale);
    ctx.moveTo(x - 7 * scale, y + 17 * scale);
    ctx.lineTo(x + 7 * scale, y + 17 * scale);
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

  private layoutMessage(
    message: ChatMessage,
    theme: RenderTheme,
    metrics: RenderMetrics,
    previous?: ChatMessage,
    next?: ChatMessage,
  ): BubbleLayout {
    const ctx = this.ctx;
    const { scale, bubbleMaxWidth: maxWidth } = metrics;
    const sequence = messageSequencePosition(previous, message, next);
    const direction = messageDirection(message, theme.selfName);
    const isSystem = direction === "system";
    const deleted = message.kind === "deleted";
    const rawCard = messageCardPresentation(message);
    const card = isSystem || deleted ? undefined : rawCard;
    const firstGroupItem = isFirstAttachmentGroupItem(message);
    const showTimestamp = shouldShowMessageTimestamp(message) && !isSystem;
    let caption = "";
    if (isSystem) {
      caption = rawCard
        ? [rawCard.title, rawCard.detail, rawCard.body].filter(Boolean).join(" · ")
        : message.displayText ?? message.text;
    } else if (deleted) {
      caption = rawCard?.title ?? "Nachricht gelöscht";
    } else if (firstGroupItem) {
      caption = card ? card.body ?? "" : cleanMediaCaption(message);
    }

    const bodyFont = `${deleted ? "italic " : ""}400 ${28 * scale}px system-ui, -apple-system, "Segoe UI Emoji", sans-serif`;
    const systemFont = `500 ${19 * scale}px system-ui, -apple-system, "Segoe UI Emoji", sans-serif`;
    const lines = this.wrapText(caption, maxWidth - 50 * scale, isSystem ? systemFont : bodyFont);
    const quoteLines = this.wrapText(
      firstGroupItem && !isSystem ? message.quotedText ?? "" : "",
      maxWidth - 76 * scale,
      `400 ${23 * scale}px system-ui, -apple-system, "Segoe UI Emoji", sans-serif`,
    );
    const label = senderLabel(message, theme, this.participants, this.groupChat, sequence);
    ctx.font = isSystem ? systemFont : bodyFont;
    const lineWidths = lines.map((line) => ctx.measureText(line || " ").width);
    const textWidth = Math.max(0, ...lineWidths);
    ctx.font = `600 ${22 * scale}px system-ui, -apple-system, sans-serif`;
    const senderWidth = label ? ctx.measureText(label).width : 0;

    const visualDimensions = message.attachment?.status === "found"
      ? this.media.getMediaDimensions(message.attachment.archivePath)
      : undefined;
    const hasVisual = Boolean(visualDimensions) && ["image", "sticker", "video"].includes(message.attachment?.kind ?? "");
    const hasAttachment = Boolean(message.attachment);
    let mediaWidth = 0;
    let mediaHeight = 0;
    if (!hasVisual && hasAttachment) {
      mediaWidth = Math.min(582 * scale, maxWidth - 20 * scale);
      mediaHeight = /\.(?:vcf|vcard)$/iu.test(message.attachment?.displayName ?? "") ? 132 * scale : 96 * scale;
    }

    const cardWidth = card ? Math.min(620 * scale, maxWidth - 20 * scale) : 0;
    const cardDetailLines = card
      ? this.wrapText(card.detail ?? "", cardWidth - 112 * scale, `400 ${21 * scale}px system-ui, -apple-system, "Segoe UI Emoji", sans-serif`)
      : [];
    const cardItemLines = card
      ? card.items.map((item) => this.wrapText(item, cardWidth - 80 * scale, `400 ${22 * scale}px system-ui, -apple-system, "Segoe UI Emoji", sans-serif`))
      : [];
    const cardItemHeights = cardItemLines.map((itemLines) => Math.max(40 * scale, itemLines.length * 27 * scale + 13 * scale));
    const cardHeaderHeight = card ? Math.max(72 * scale, 54 * scale + cardDetailLines.length * 26 * scale) : 0;
    const cardHeight = card ? cardHeaderHeight + cardItemHeights.reduce((sum, itemHeight) => sum + itemHeight + 8 * scale, 0) + 14 * scale : 0;
    const senderHeight = label ? 29 * scale : 0;
    const forwardedHeight = forwardedPresentationLabel(message) ? 25 * scale : 0;
    const quoteHeight = quoteLines.length ? quoteLines.length * 29 * scale + 22 * scale : 0;
    const textHeight = lines.length ? lines.length * (isSystem ? 27 : 36) * scale : 0;

    ctx.font = `400 ${18 * scale}px system-ui, -apple-system, sans-serif`;
    const timeLabel = `${message.edited ? "bearbeitet · " : ""}${formatTime(message.timestamp)}`;
    const timeWidth = showTimestamp
      ? ctx.measureText(timeLabel).width + (direction === "outgoing" ? 29 * scale : 0)
      : 0;

    if (hasVisual && message.attachment) {
      const dimensions = visualDimensions ?? { width: 16, height: 9 };
      const chatViewportHeight = Math.max(260 * scale, this.canvas.height - metrics.headerHeight - metrics.composerHeight);
      const nonMediaHeight = senderHeight + forwardedHeight + quoteHeight + cardHeight + textHeight + 78 * scale;
      const maxVisualHeight = Math.max(120 * scale, Math.min(chatViewportHeight * 0.72, chatViewportHeight - nonMediaHeight));
      const roleMaxWidth = message.mediaRole === "sticker"
        ? Math.min(330 * scale, maxWidth - 10 * scale)
        : message.mediaRole === "video-note"
          ? Math.min(430 * scale, maxWidth - 10 * scale)
          : maxWidth - 10 * scale;
      const roleMaxHeight = message.mediaRole === "sticker" ? Math.min(maxVisualHeight, 330 * scale) : maxVisualHeight;
      const fitted = fitMediaBox(dimensions.width, dimensions.height, roleMaxWidth, roleMaxHeight);
      mediaWidth = fitted.width;
      mediaHeight = fitted.height;
    }

    const timestampOverlay = showTimestamp
      && hasVisual
      && !card
      && !lines.length
      && !quoteLines.length
      && !label
      && !forwardedPresentationLabel(message);
    const lastLineWidth = lineWidths[lineWidths.length - 1] ?? 0;
    const timestampInline = showTimestamp
      && lines.length > 0
      && !hasVisual
      && !hasAttachment
      && !card
      && !quoteLines.length
      && !label
      && !forwardedPresentationLabel(message)
      && lastLineWidth + timeWidth + 22 * scale <= maxWidth - 50 * scale;
    const topPadding = isSystem ? 11 * scale : hasVisual ? 5 * scale : 14 * scale;
    const bottomPadding = timestampOverlay || hasVisual ? 5 * scale : 10 * scale;
    const horizontalPadding = isSystem ? 34 * scale : hasVisual ? 10 * scale : 50 * scale;
    let baseWidth = Math.max(
      isSystem ? 140 * scale : 180 * scale,
      mediaWidth ? mediaWidth + 10 * scale : 0,
      cardWidth ? cardWidth + 20 * scale : 0,
      textWidth + horizontalPadding,
      senderWidth + 50 * scale,
    );
    if (timestampInline) baseWidth = Math.max(baseWidth, lastLineWidth + timeWidth + 72 * scale);
    if (showTimestamp && !timestampOverlay && !timestampInline && !mediaHeight && !cardHeight) {
      baseWidth = Math.max(baseWidth, timeWidth + 50 * scale);
    }
    const width = Math.min(maxWidth, baseWidth);
    const quoteSpacing = quoteHeight ? 8 * scale : 0;
    const cardSpacing = cardHeight && (mediaHeight || textHeight) ? 10 * scale : 0;
    const mediaSpacing = mediaHeight && textHeight ? 10 * scale : 0;
    const footerHeight = showTimestamp && !timestampInline && !timestampOverlay ? 25 * scale : 0;
    const height = topPadding + senderHeight + forwardedHeight + quoteHeight + quoteSpacing
      + cardHeight + cardSpacing + mediaHeight + mediaSpacing + textHeight + footerHeight + bottomPadding;
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
      sequence,
      timestampInline,
      timestampOverlay,
      topPadding,
      bottomPadding,
    };
  }

  private drawMessages(timeline: CompiledTimeline, time: number, theme: RenderTheme, palette: Palette, bottom: number, metrics: RenderMetrics): void {
    const visibleCount = visibleEventCount(timeline, time);
    if (!visibleCount) return;
    const { scale } = metrics;
    const start = Math.max(0, visibleCount - 90);
    const events = timeline.events.slice(start, visibleCount);
    const layouts = events.map((event, index) => this.layoutMessage(
      event.message,
      theme,
      metrics,
      timeline.events[start + index - 1]?.message,
      timeline.events[start + index + 1]?.message,
    ));
    const gaps = layouts.map((layout, index) => messageGapAfter(
      layout.message,
      timeline.events[start + index + 1]?.message,
      scale,
    ));
    const progresses = events.map((event) => easeOut((time - event.at) / event.revealDuration));
    const dateHeight = 54 * scale;
    const total = layouts.reduce((sum, layout, index) => {
      const progress = progresses[index] ?? 1;
      return sum + (layout.height + (gaps[index] ?? 14 * scale) + (layout.dateLabel ? dateHeight : 0)) * progress;
    }, 0);
    // Anchor the newest message above the composer. When the chat is taller than
    // the viewport, older bubbles deliberately move above the clipping region.
    let y = bottom - 18 * scale - total;
    const latestLayout = layouts[layouts.length - 1];
    const latestEvent = events[events.length - 1];
    if (latestLayout && latestEvent) {
      const latestEntryHeight = latestLayout.height + (gaps[gaps.length - 1] ?? 15 * scale) + (latestLayout.dateLabel ? dateHeight : 0);
      const availableHeight = Math.max(120 * scale, bottom - metrics.headerHeight - 36 * scale);
      const nextEventAt = timeline.events[visibleCount]?.at ?? timeline.duration;
      y += oversizedBubbleScrollOffset(
        latestEntryHeight,
        availableHeight,
        time - latestEvent.at,
        nextEventAt - latestEvent.at,
      );
    }
    const centerX = metrics.contentX + metrics.contentWidth / 2;

    layouts.forEach((layout, index) => {
      const event = events[index];
      if (!event) return;
      const progress = progresses[index] ?? 1;
      if (layout.dateLabel) {
        this.ctx.font = `500 ${18 * scale}px system-ui, -apple-system, sans-serif`;
        const chipWidth = this.ctx.measureText(layout.dateLabel).width + 34 * scale;
        const chipY = y + (1 - progress) * 18 * scale + 6 * scale;
        this.ctx.save();
        this.ctx.globalAlpha = progress;
        roundedRect(this.ctx, centerX - chipWidth / 2, chipY, chipWidth, 36 * scale, 12 * scale);
        this.ctx.fillStyle = palette.system;
        this.ctx.fill();
        this.ctx.fillStyle = palette.mutedText;
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "middle";
        this.ctx.fillText(layout.dateLabel, centerX, chipY + 18 * scale);
        this.ctx.restore();
        y += dateHeight * progress;
      }
      const translatedY = y + (1 - progress) * 24 * scale;
      this.ctx.save();
      this.ctx.globalAlpha = progress;
      this.drawBubble(layout, theme, palette, translatedY, metrics);
      this.ctx.restore();
      y += (layout.height + (gaps[index] ?? 14 * scale)) * progress;
    });
  }

  private drawBubble(layout: BubbleLayout, theme: RenderTheme, palette: Palette, y: number, metrics: RenderMetrics): void {
    const ctx = this.ctx;
    const { scale, contentX, contentWidth, sidePadding } = metrics;
    const direction = messageDirection(layout.message, theme.selfName);
    const isSystem = direction === "system";
    const mine = direction === "outgoing";
    const width = layout.width;
    const left = contentX + sidePadding;
    const right = contentX + contentWidth - sidePadding;
    const x = isSystem ? contentX + (contentWidth - width) / 2 : mine ? right - width : left;
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
      const radius = 12 * scale;
      const joinedTop = ["middle", "last"].includes(layout.sequence);
      const joinedBottom = ["first", "middle"].includes(layout.sequence);
      const topLeft = !isSystem && !mine && joinedTop ? 4 * scale : radius;
      const topRight = !isSystem && mine && joinedTop ? 4 * scale : radius;
      const bottomRight = !isSystem && mine && joinedBottom ? 4 * scale : radius;
      const bottomLeft = !isSystem && !mine && joinedBottom ? 4 * scale : radius;
      roundedRectCorners(ctx, x, y, width, layout.height, topLeft, topRight, bottomRight, bottomLeft);
      ctx.fillStyle = isSystem ? palette.system : mine ? palette.outgoing : palette.incoming;
      ctx.fill();
      const showTail = !isSystem && ["single", "first"].includes(layout.sequence);
      if (showTail) {
        ctx.beginPath();
        if (mine) {
          ctx.moveTo(x + width - 3 * scale, y + 2 * scale);
          ctx.lineTo(x + width + 10 * scale, y + 2 * scale);
          ctx.lineTo(x + width - 1 * scale, y + 18 * scale);
        } else {
          ctx.moveTo(x + 3 * scale, y + 2 * scale);
          ctx.lineTo(x - 10 * scale, y + 2 * scale);
          ctx.lineTo(x + 1 * scale, y + 18 * scale);
        }
        ctx.closePath();
        ctx.fill();
      }
    }
    let cursorY = y + layout.topPadding;
    if (layout.senderLabel) {
      ctx.fillStyle = senderColor(layout.message.sender ?? "", this.participants, palette);
      ctx.font = `600 ${22 * scale}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(layout.senderLabel, x + 25 * scale, cursorY);
      cursorY += 29 * scale;
    }
    const forwardedLabel = forwardedPresentationLabel(layout.message);
    if (forwardedLabel) {
      ctx.fillStyle = palette.mutedText;
      ctx.font = `italic 400 ${19 * scale}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(forwardedLabel, x + 25 * scale, cursorY);
      cursorY += 25 * scale;
    }
    if (layout.quoteLines.length) {
      const quoteHeight = layout.quoteLines.length * 29 * scale + 22 * scale;
      this.drawQuoteBlock(layout.quoteLines, x + 15 * scale, cursorY, width - 30 * scale, quoteHeight, palette, scale);
      cursorY += quoteHeight + 8 * scale;
    }
    if (layout.card && layout.cardHeight > 0) {
      const cardX = x + (width - layout.cardWidth) / 2;
      this.drawSpecialCard(layout, cardX, cursorY, layout.cardWidth, layout.cardHeight, palette, scale);
      cursorY += layout.cardHeight + (layout.mediaHeight || layout.lines.length ? 10 * scale : 0);
    }
    if (layout.mediaHeight > 0) {
      const mediaX = x + (width - layout.mediaWidth) / 2;
      this.drawMedia(layout, mediaX, cursorY, layout.mediaWidth, layout.mediaHeight, palette, scale);
      cursorY += layout.mediaHeight + (layout.lines.length ? 10 * scale : 0);
    }
    if (layout.lines.length) {
      this.drawTextLines(
        layout.lines,
        x + (isSystem ? 17 : 25) * scale,
        cursorY,
        width - (isSystem ? 34 : 50) * scale,
        palette,
        scale,
        isSystem,
        layout.message.kind === "deleted" ? "deleted" : isSystem ? "system" : "normal",
      );
    }
    if (isSystem || !shouldShowMessageTimestamp(layout.message)) return;
    const timeLabel = `${layout.message.edited ? "bearbeitet · " : ""}${formatTime(layout.message.timestamp)}`;
    ctx.font = `400 ${18 * scale}px system-ui, -apple-system, sans-serif`;
    const checkWidth = mine ? 25 * scale : 0;
    if (layout.timestampOverlay || bareSticker) {
      const chipWidth = ctx.measureText(timeLabel).width + checkWidth + 18 * scale;
      roundedRect(ctx, x + width - chipWidth - 8 * scale, y + layout.height - 31 * scale, chipWidth, 25 * scale, 8 * scale);
      ctx.fillStyle = "rgba(0, 0, 0, .55)";
      ctx.fill();
    }
    const timeRight = x + width - (mine ? 34 : 15) * scale;
    ctx.fillStyle = layout.timestampOverlay || bareSticker ? "#ffffff" : mine ? palette.outgoingMuted : palette.mutedText;
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText(timeLabel, timeRight, y + layout.height - layout.bottomPadding);
    if (mine) {
      this.drawSentCheck(
        x + width - 22 * scale,
        y + layout.height - layout.bottomPadding - 7 * scale,
        layout.timestampOverlay || bareSticker ? "#ffffff" : palette.outgoingMuted,
        scale,
      );
    }
  }

  private drawSentCheck(x: number, y: number, color: string, scale: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.2, 2 * scale);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(x - 6 * scale, y);
    ctx.lineTo(x - 1 * scale, y + 5 * scale);
    ctx.lineTo(x + 8 * scale, y - 6 * scale);
    ctx.stroke();
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
    ctx.fillStyle = palette.text;
    ctx.font = `400 ${23 * scale}px system-ui, -apple-system, "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    lines.forEach((line, index) => ctx.fillText(line, x + 19 * scale, y + 11 * scale + index * 29 * scale));
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

  private drawTextLines(
    lines: string[],
    x: number,
    y: number,
    width: number,
    palette: Palette,
    scale: number,
    centered: boolean,
    variant: "normal" | "system" | "deleted" = "normal",
  ): void {
    const ctx = this.ctx;
    ctx.fillStyle = variant === "normal" ? palette.text : palette.mutedText;
    ctx.font = variant === "system"
      ? `500 ${19 * scale}px system-ui, -apple-system, "Segoe UI Emoji", sans-serif`
      : `${variant === "deleted" ? "italic " : ""}400 ${28 * scale}px system-ui, -apple-system, "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = centered ? "center" : "left";
    ctx.textBaseline = "top";
    const drawX = centered ? x + width / 2 : x;
    const lineHeight = (variant === "system" ? 27 : 36) * scale;
    lines.forEach((line, index) => ctx.fillText(line, drawX, y + index * lineHeight));
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
    const buttonX = x + 42 * scale;
    const middleY = y + 43 * scale;
    ctx.fillStyle = palette.accent;
    ctx.beginPath();
    ctx.arc(buttonX, middleY, 27 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    if (active) {
      ctx.fillRect(buttonX - 7 * scale, middleY - 9 * scale, 5 * scale, 18 * scale);
      ctx.fillRect(buttonX + 3 * scale, middleY - 9 * scale, 5 * scale, 18 * scale);
    } else {
      ctx.moveTo(buttonX - 6 * scale, middleY - 11 * scale);
      ctx.lineTo(buttonX + 11 * scale, middleY);
      ctx.lineTo(buttonX - 6 * scale, middleY + 11 * scale);
      ctx.closePath();
      ctx.fill();
    }

    const waveformX = x + 80 * scale;
    const waveformWidth = Math.max(80 * scale, width - 102 * scale);
    const barStep = waveformWidth / clip.peaks.length;
    clip.peaks.forEach((peak, index) => {
      const barProgress = (index + 0.5) / clip.peaks.length;
      const barHeight = Math.max(4 * scale, peak * 34 * scale);
      ctx.fillStyle = barProgress <= progress ? palette.accent : palette.mutedText;
      ctx.fillRect(waveformX + index * barStep, middleY - barHeight / 2, Math.max(2 * scale, barStep * 0.42), barHeight);
    });

    ctx.fillStyle = palette.mutedText;
    ctx.font = `400 ${17 * scale}px system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    const shownSeconds = active ? elapsed : clip.duration;
    ctx.fillText(`${Math.floor(shownSeconds / 60)}:${String(Math.floor(shownSeconds % 60)).padStart(2, "0")}`, waveformX, y + height - 8 * scale);
  }
}
