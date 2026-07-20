import { ALL_FORMATS, BlobSource, Input, VideoSample, VideoSampleSink } from "mediabunny";
import { VIDEO_PREVIEW_SECONDS, visibleEventCount } from "./timeline";
import type {
  ArchiveAsset,
  ChatMessage,
  CompiledTimeline,
  ImportedProject,
  RenderTheme,
} from "./types";

type DrawableImage = ImageBitmap | HTMLImageElement;

interface VideoDecoderEntry {
  input: Input<BlobSource>;
  sink: VideoSampleSink;
  firstTimestamp: number;
  duration: number;
  frame: VideoSample | null;
  frameTime: number;
  pending: Promise<void> | null;
  exportIterator: AsyncGenerator<VideoSample | null, void, unknown> | null;
  exportTimes: number[];
  exportCursor: number;
  exportFallback: boolean;
}

interface BubbleLayout {
  message: ChatMessage;
  lines: string[];
  senderLabel: string;
  width: number;
  height: number;
  mediaHeight: number;
  dateLabel?: string;
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
  if (!message.attachment) return message.text;
  const withoutTag = message.text
    .replace(/[\u200E\u200F]?\s*<[^:>\n]{1,48}:\s*[^>\n]+\.(?:jpe?g|png|gif|webp|heic|heif|mp4|mov|m4v|webm|opus|ogg|m4a|mp3|aac|wav|pdf|docx?|xlsx?|pptx?|zip)>/iu, "")
    .replace(/^.*\.(?:jpe?g|png|webp|gif|heic|mp4|mov|webm|opus|ogg|m4a|mp3|pdf).*\((?:file attached|datei angehängt)\)\s*/iu, "")
    .trim();
  if (withoutTag !== message.text.trim()) return withoutTag;
  if (message.kind === "media-omitted") return "";
  return message.text;
}

function pseudonym(name: string, participants: string[]): string {
  const index = Math.max(0, participants.indexOf(name));
  return `Person ${String.fromCharCode(65 + (index % 26))}`;
}

function senderLabel(message: ChatMessage, theme: RenderTheme, participants: string[]): string {
  if (!message.sender || message.sender === theme.selfName) return "";
  return theme.anonymize ? pseudonym(message.sender, participants) : message.sender;
}

export class AssetMediaStore {
  private readonly assets = new Map<string, ArchiveAsset>();
  private readonly images = new Map<string, DrawableImage>();
  private readonly videos = new Map<string, VideoDecoderEntry>();
  private readonly failed = new Set<string>();

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

  async preloadForMessages(messages: ChatMessage[], onProgress?: (done: number, total: number) => void): Promise<void> {
    const paths = [...new Set(messages
      .filter((message) => message.attachment?.status === "found" && ["image", "sticker", "video"].includes(message.attachment.kind))
      .map((message) => message.attachment?.archivePath)
      .filter((path): path is string => Boolean(path)))];
    let done = 0;
    for (const path of paths) {
      await this.load(path);
      done += 1;
      onProgress?.(done, paths.length);
    }
  }

  async load(path: string): Promise<void> {
    if (this.images.has(path) || this.videos.has(path) || this.failed.has(path)) return;
    const asset = this.assets.get(path);
    if (!asset || asset.size > 80 * 1024 * 1024 || /heic|heif/iu.test(asset.mimeType)) {
      this.failed.add(path);
      return;
    }
    try {
      if (asset.kind === "video") {
        await this.loadVideo(asset);
        return;
      }
      const blob = await asset.loadBlob();
      if ("createImageBitmap" in window) {
        const bitmap = await createImageBitmap(blob);
        this.images.set(path, bitmap);
      } else {
        const url = URL.createObjectURL(blob);
        const image = new Image();
        await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error("Bild konnte nicht geladen werden"));
          image.src = url;
        });
        URL.revokeObjectURL(url);
        this.images.set(path, image);
      }
    } catch {
      this.failed.add(path);
    }
  }

  private async loadVideo(asset: ArchiveAsset): Promise<void> {
    let input: Input<BlobSource> | null = null;
    try {
      const blob = await asset.loadBlob();
      input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
      if (!await input.canRead()) throw new Error("Videoformat nicht lesbar");
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error("Keine Videospur gefunden");
      if (!await track.canDecode()) throw new Error("Videocodec wird von diesem Browser nicht unterstützt");
      const firstTimestamp = await track.getFirstTimestamp();
      const endTimestamp = await track.getDurationFromMetadata() ?? await track.computeDuration();
      const entry: VideoDecoderEntry = {
        input,
        sink: new VideoSampleSink(track),
        firstTimestamp,
        duration: Math.max(0.01, endTimestamp - firstTimestamp),
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
        const result = await entry.exportIterator.next();
        entry.exportCursor += 1;
        if (!result.value) continue;
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
        entry.frame?.close();
        entry.frame = sample;
        entry.frameTime = target;
      })
      .catch(() => {
        this.failed.add(path);
      })
      .finally(() => {
        entry.pending = null;
      });
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
      items.push({ eventAt: event.at, duration: Math.min(VIDEO_PREVIEW_SECONDS, entry.duration) });
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

  dispose(): void {
    for (const image of this.images.values()) {
      if ("close" in image && typeof image.close === "function") image.close();
    }
    for (const video of this.videos.values()) {
      void video.exportIterator?.return();
      video.frame?.close();
      video.input.dispose();
    }
    this.images.clear();
    this.videos.clear();
  }
}

export class ChatCanvasRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private participants: string[] = [];
  private currentTimeline: CompiledTimeline = { events: [], duration: 0 };
  private currentTime = 0;
  private eventTimes = new Map<string, number>();

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
    }
    this.currentTime = time;
    const ctx = this.ctx;
    const { width: w, height: h } = this.canvas;
    const scale = w / 1080;
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
      if (attachment?.status !== "found" || attachment.kind !== "video") continue;
      const duration = Math.min(VIDEO_PREVIEW_SECONDS, this.media.getVideoDuration(attachment.archivePath) ?? VIDEO_PREVIEW_SECONDS);
      const elapsed = clamp(time - event.at, 0, Math.max(0, duration - 0.001));
      const active = time - event.at <= duration + 0.25;
      if (active || !this.media.getVideoFrame(attachment.archivePath)) {
        promises.push(this.media.prepareVideoFrame(attachment.archivePath, elapsed, exact));
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
          for (const character of [...line]) {
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
    return result.slice(0, 36);
  }

  private layoutMessage(message: ChatMessage, theme: RenderTheme, scale: number, previous?: ChatMessage): BubbleLayout {
    const ctx = this.ctx;
    const maxWidth = 760 * scale;
    const font = `400 ${30 * scale}px system-ui, -apple-system, "Segoe UI Emoji", sans-serif`;
    const caption = cleanMediaCaption(message);
    const lines = this.wrapText(caption, maxWidth - 54 * scale, font);
    const label = senderLabel(message, theme, this.participants);
    ctx.font = font;
    const textWidth = Math.max(0, ...lines.map((line) => ctx.measureText(line || " ").width));
    ctx.font = `500 ${23 * scale}px system-ui, -apple-system, sans-serif`;
    const senderWidth = label ? ctx.measureText(label).width : 0;
    const hasVisual = message.attachment?.status === "found" && ["image", "sticker", "video"].includes(message.attachment.kind);
    const hasAttachment = Boolean(message.attachment);
    const mediaHeight = hasVisual ? 360 * scale : hasAttachment ? 104 * scale : 0;
    const baseWidth = hasVisual ? 650 * scale : hasAttachment ? 610 * scale : Math.max(190 * scale, textWidth + 58 * scale, senderWidth + 58 * scale);
    const width = Math.min(maxWidth, baseWidth);
    const senderHeight = label ? 34 * scale : 0;
    const textHeight = lines.length ? lines.length * 39 * scale + 8 * scale : 0;
    const height = 28 * scale + senderHeight + mediaHeight + textHeight + 35 * scale;
    const dateLabel = !previous || dayKey(previous.timestamp) !== dayKey(message.timestamp) ? formatDay(message.timestamp) : undefined;
    return { message, lines, senderLabel: label, width, height, mediaHeight, dateLabel };
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
    const gap = 15 * scale;
    const dateHeight = 66 * scale;
    const total = layouts.reduce((sum, layout) => sum + layout.height + gap + (layout.dateLabel ? dateHeight : 0), 0);
    // Anchor the newest message above the composer. When the chat is taller than
    // the viewport, older bubbles deliberately move above the clipping region.
    let y = bottom - 24 * scale - total;
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
      y += layout.height + gap;
    });
  }

  private drawBubble(layout: BubbleLayout, theme: RenderTheme, palette: Palette, y: number, scale: number): void {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const isSystem = !layout.message.sender;
    if (isSystem) {
      const width = Math.min(720 * scale, layout.width);
      const x = (w - width) / 2;
      roundedRect(ctx, x, y, width, layout.height, 18 * scale);
      ctx.fillStyle = palette.system;
      ctx.fill();
      this.drawTextLines(layout.lines, x + 27 * scale, y + 25 * scale, width - 54 * scale, palette, scale, true);
      return;
    }
    const mine = layout.message.sender === theme.selfName;
    const x = mine ? w - 34 * scale - layout.width : 34 * scale;
    roundedRect(ctx, x, y, layout.width, layout.height, 20 * scale);
    ctx.fillStyle = mine ? palette.outgoing : palette.incoming;
    ctx.fill();
    let cursorY = y + 23 * scale;
    if (layout.senderLabel) {
      ctx.fillStyle = palette.accent;
      ctx.font = `500 ${23 * scale}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(layout.senderLabel, x + 27 * scale, cursorY);
      cursorY += 34 * scale;
    }
    if (layout.mediaHeight > 0) {
      this.drawMedia(layout, x + 14 * scale, cursorY, layout.width - 28 * scale, layout.mediaHeight - 12 * scale, palette, scale);
      cursorY += layout.mediaHeight;
    }
    if (layout.lines.length) this.drawTextLines(layout.lines, x + 27 * scale, cursorY, layout.width - 54 * scale, palette, scale, false);
    ctx.fillStyle = palette.mutedText;
    ctx.font = `400 ${19 * scale}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    const check = mine ? "  ✓✓" : "";
    ctx.fillText(`${formatTime(layout.message.timestamp)}${check}`, x + layout.width - 20 * scale, y + layout.height - 12 * scale);
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
    roundedRect(ctx, x, y, width, height, 14 * scale);
    ctx.save();
    ctx.clip();
    ctx.fillStyle = palette.media;
    ctx.fillRect(x, y, width, height);
    const image = attachment?.archivePath ? this.media.getImage(attachment.archivePath) : undefined;
    const videoFrame = attachment?.kind === "video" && attachment.archivePath
      ? this.media.getVideoFrame(attachment.archivePath)
      : undefined;
    if (image) {
      const sourceW = "naturalWidth" in image ? image.naturalWidth : image.width;
      const sourceH = "naturalHeight" in image ? image.naturalHeight : image.height;
      const ratio = Math.max(width / sourceW, height / sourceH);
      const drawW = sourceW * ratio;
      const drawH = sourceH * ratio;
      ctx.drawImage(image, x + (width - drawW) / 2, y + (height - drawH) / 2, drawW, drawH);
    } else if (videoFrame) {
      const sourceW = videoFrame.displayWidth;
      const sourceH = videoFrame.displayHeight;
      const sourceRatio = sourceW / sourceH;
      const targetRatio = width / height;
      if (sourceRatio > targetRatio) {
        const cropW = sourceH * targetRatio;
        videoFrame.draw(ctx, (sourceW - cropW) / 2, 0, cropW, sourceH, x, y, width, height);
      } else {
        const cropH = sourceW / targetRatio;
        videoFrame.draw(ctx, 0, (sourceH - cropH) / 2, sourceW, cropH, x, y, width, height);
      }
      const eventAt = this.eventTimes.get(layout.message.id) ?? this.currentTime;
      const clipDuration = Math.min(VIDEO_PREVIEW_SECONDS, this.media.getVideoDuration(attachment?.archivePath ?? "") ?? VIDEO_PREVIEW_SECONDS);
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
      ctx.fillText(`VIDEO · ${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, "0")}`, x + 16 * scale, y + height - 27 * scale);
    } else {
      ctx.fillStyle = palette.mutedText;
      ctx.font = `500 ${25 * scale}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const icon = attachment?.kind === "video" ? "▶" : attachment?.kind === "audio" ? "◖)))" : attachment?.kind === "document" ? "▤" : "▧";
      ctx.font = `500 ${46 * scale}px system-ui, -apple-system, sans-serif`;
      ctx.fillText(icon, x + width / 2, y + height / 2 - 18 * scale);
      ctx.font = `400 ${22 * scale}px system-ui, -apple-system, sans-serif`;
      const label = attachment?.status === "missing" ? "Medium nicht gefunden" : attachment?.displayName ?? "Medium";
      ctx.fillText(label.slice(0, 42), x + width / 2, y + height / 2 + 27 * scale);
    }
    ctx.restore();
  }
}
