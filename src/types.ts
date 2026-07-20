export type DateOrder = "auto" | "dmy" | "mdy" | "ymd";

export type MediaKind = "image" | "video" | "audio" | "document" | "sticker";

export interface Attachment {
  archivePath: string;
  displayName: string;
  kind: MediaKind;
  mimeType: string;
  size: number;
  status: "found" | "missing" | "ambiguous";
}

export interface ChatMessage {
  id: string;
  sourceOrder: number;
  timestamp: Date;
  rawTimestamp: string;
  precision: "minute" | "second";
  sender: string | null;
  text: string;
  kind: "text" | "system" | "media" | "media-omitted" | "deleted" | "unknown";
  mediaHint?: MediaKind;
  mediaReference?: string;
  attachment?: Attachment;
  warnings: string[];
}

export interface ParseDiagnostics {
  totalLines: number;
  parsedMessages: number;
  unparsedPreambleLines: number;
  invalidTimestampLines: number;
  dateOrder: Exclude<DateOrder, "auto">;
  dateOrderAmbiguous: boolean;
  reversedTimestamps: number;
  warnings: string[];
}

export interface ParsedChat {
  messages: ChatMessage[];
  participants: string[];
  preamble: string[];
  diagnostics: ParseDiagnostics;
}

export interface ArchiveAsset {
  path: string;
  basename: string;
  normalizedBasename: string;
  size: number;
  kind: MediaKind;
  mimeType: string;
  loadBlob: () => Promise<Blob>;
}

export interface ImportedProject {
  filename: string;
  chatFilename: string;
  chatText: string;
  chat: ParsedChat;
  assets: ArchiveAsset[];
  attachmentStats: {
    matched: number;
    missing: number;
    ambiguous: number;
    unreferenced: number;
  };
}

export type TimingMode = "adaptive" | "fixed" | "factor";

export interface TimelineSettings {
  mode: TimingMode;
  baseInterval: number;
  maxPause: number;
  speedFactor: number;
  endHold: number;
}

export interface TimelineEvent {
  message: ChatMessage;
  messageIndex: number;
  at: number;
  revealDuration: number;
}

export interface CompiledTimeline {
  events: TimelineEvent[];
  duration: number;
}

export interface RenderTheme {
  mode: "light" | "dark";
  title: string;
  selfName: string;
  anonymize: boolean;
}

export interface ExportPreset {
  id: string;
  label: string;
  width: number;
  height: number;
  bitrate: number;
}
