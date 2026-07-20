import JSZip, { type JSZipObject } from "jszip";
import { mediaKindFromFilename, parseChat, scoreChatText } from "./parser";
import type {
  ArchiveAsset,
  Attachment,
  ChatMessage,
  DateOrder,
  ImportedProject,
  MediaKind,
} from "./types";

const MAX_ARCHIVE_BYTES = 750 * 1024 * 1024;
const MAX_FILES = 12_000;
const MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TEXT_BYTES = 80 * 1024 * 1024;
const MEDIA_EXTENSIONS = /\.(?:jpe?g|png|gif|webp|heic|heif|mp4|mov|m4v|webm|opus|ogg|m4a|mp3|aac|wav|pdf|docx?|xlsx?|pptx?|zip)$/iu;

interface ZipSizes {
  compressedSize?: number;
  uncompressedSize?: number;
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function normalizeFilename(value: string): string {
  return value
    .replace(/[\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, "")
    .trim()
    .normalize("NFC")
    .toLocaleLowerCase();
}

function mimeForFilename(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const types: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    webp: "image/webp", heic: "image/heic", heif: "image/heif",
    mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", webm: "video/webm",
    opus: "audio/opus", ogg: "audio/ogg", m4a: "audio/mp4", mp3: "audio/mpeg", aac: "audio/aac", wav: "audio/wav",
    pdf: "application/pdf", doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    zip: "application/zip",
  };
  return types[ext] ?? "application/octet-stream";
}

function entrySizes(entry: JSZipObject): ZipSizes {
  return (entry as unknown as { _data?: ZipSizes })._data ?? {};
}

function validatePath(path: string): void {
  const normalized = path.replace(/\\/gu, "/");
  const segments = normalized.split("/");
  if (normalized.startsWith("/") || /^[a-z]:\//iu.test(normalized) || segments.includes("..")) {
    throw new Error(`Unsicherer Dateipfad im ZIP: ${path}`);
  }
}

function makeAsset(entry: JSZipObject): ArchiveAsset {
  const name = basename(entry.name);
  const { uncompressedSize = 0 } = entrySizes(entry);
  return {
    path: entry.name,
    basename: name,
    normalizedBasename: normalizeFilename(name),
    size: uncompressedSize,
    kind: mediaKindFromFilename(name),
    mimeType: mimeForFilename(name),
    loadBlob: async () => entry.async("blob"),
  };
}

function attachmentFrom(asset: ArchiveAsset, status: Attachment["status"]): Attachment {
  return {
    archivePath: asset.path,
    displayName: asset.basename,
    kind: asset.kind,
    mimeType: asset.mimeType,
    size: asset.size,
    status,
  };
}

function missingAttachment(reference: string, kind?: MediaKind): Attachment {
  return {
    archivePath: "",
    displayName: reference,
    kind: kind ?? mediaKindFromFilename(reference),
    mimeType: mimeForFilename(reference),
    size: 0,
    status: "missing",
  };
}

export function associateAttachments(messages: ChatMessage[], assets: ArchiveAsset[]): ImportedProject["attachmentStats"] {
  const byBasename = new Map<string, ArchiveAsset[]>();
  for (const asset of assets) {
    const current = byBasename.get(asset.normalizedBasename) ?? [];
    current.push(asset);
    byBasename.set(asset.normalizedBasename, current);
  }
  const used = new Set<string>();
  let matched = 0;
  let missing = 0;
  let ambiguous = 0;

  for (const message of messages) {
    if (!message.mediaReference) continue;
    const normalized = normalizeFilename(basename(message.mediaReference));
    const candidates = byBasename.get(normalized) ?? [];
    if (candidates.length === 1 && candidates[0]) {
      message.attachment = attachmentFrom(candidates[0], "found");
      used.add(candidates[0].path);
      matched += 1;
    } else if (candidates.length > 1 && candidates[0]) {
      message.attachment = attachmentFrom(candidates[0], "ambiguous");
      ambiguous += 1;
    } else {
      message.attachment = missingAttachment(message.mediaReference, message.mediaHint);
      missing += 1;
    }
  }

  const queues = new Map<MediaKind, ArchiveAsset[]>();
  for (const kind of ["image", "video", "audio", "document", "sticker"] as MediaKind[]) {
    queues.set(kind, assets.filter((asset) => asset.kind === kind && !used.has(asset.path)));
  }
  for (const message of messages) {
    if (message.kind !== "media-omitted" || message.attachment) continue;
    const kinds = message.mediaHint ? [message.mediaHint] : ["image", "video", "audio", "sticker"] as MediaKind[];
    let candidate: ArchiveAsset | undefined;
    for (const kind of kinds) {
      candidate = queues.get(kind)?.shift();
      if (candidate) break;
    }
    if (candidate) {
      message.attachment = attachmentFrom(candidate, "found");
      used.add(candidate.path);
      matched += 1;
    }
  }

  return { matched, missing, ambiguous, unreferenced: Math.max(0, assets.length - used.size) };
}

async function importTextFile(file: File, dateOrder: DateOrder): Promise<ImportedProject> {
  const chatText = await file.text();
  const chat = parseChat(chatText, dateOrder);
  if (!chat.messages.length) throw new Error("In der Textdatei wurden keine WhatsApp-Nachrichten erkannt.");
  return {
    filename: file.name,
    chatFilename: file.name,
    chatText,
    chat,
    assets: [],
    attachmentStats: { matched: 0, missing: 0, ambiguous: 0, unreferenced: 0 },
  };
}

export async function importWhatsAppExport(file: File, dateOrder: DateOrder = "auto"): Promise<ImportedProject> {
  if (file.name.toLowerCase().endsWith(".txt")) return importTextFile(file, dateOrder);
  if (!file.name.toLowerCase().endsWith(".zip")) throw new Error("Bitte eine WhatsApp-ZIP oder die exportierte Chat-TXT auswählen.");
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error("Das ZIP ist größer als 750 MB. Bitte einen kürzeren Chatzeitraum oder einen Export ohne Medien verwenden.");

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file, { checkCRC32: false, createFolders: false });
  } catch {
    throw new Error("Das ZIP konnte nicht geöffnet werden. Es ist möglicherweise beschädigt oder verschlüsselt.");
  }
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > MAX_FILES) throw new Error(`Das ZIP enthält zu viele Dateien (${entries.length}).`);
  let totalUncompressed = 0;
  for (const entry of entries) {
    validatePath((entry as unknown as { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name);
    const { uncompressedSize = 0, compressedSize = 0 } = entrySizes(entry);
    totalUncompressed += uncompressedSize;
    if (uncompressedSize > 100 * 1024 * 1024 && compressedSize > 0 && uncompressedSize / compressedSize > 300) {
      throw new Error(`Verdächtig stark komprimierte Datei im ZIP: ${entry.name}`);
    }
  }
  if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) throw new Error("Der entpackte Inhalt würde mehr als 2 GB belegen.");

  const textCandidates = entries.filter((entry) => entry.name.toLowerCase().endsWith(".txt") && (entrySizes(entry).uncompressedSize ?? 0) <= MAX_TEXT_BYTES);
  if (!textCandidates.length) throw new Error("Im ZIP wurde keine Chat-Textdatei gefunden.");
  const scored: Array<{ entry: JSZipObject; text: string; score: number }> = [];
  for (const entry of textCandidates) {
    const text = await entry.async("string");
    const nameBonus = /(?:^|\/)_(?:chat|conversation)\.txt$/iu.test(entry.name) ? 0.5 : 0;
    scored.push({ entry, text, score: scoreChatText(text) + nameBonus });
  }
  scored.sort((a, b) => b.score - a.score);
  const selected = scored[0];
  if (!selected || selected.score < 10) throw new Error("Die Textdateien im ZIP sehen nicht wie ein WhatsApp-Export aus.");

  const assets = entries.filter((entry) => MEDIA_EXTENSIONS.test(entry.name)).map(makeAsset);
  const chat = parseChat(selected.text, dateOrder);
  if (!chat.messages.length) throw new Error("Es konnten keine Nachrichten aus dem WhatsApp-Export gelesen werden.");
  const attachmentStats = associateAttachments(chat.messages, assets);
  return {
    filename: file.name,
    chatFilename: selected.entry.name,
    chatText: selected.text,
    chat,
    assets,
    attachmentStats,
  };
}

export function reparseProject(project: ImportedProject, dateOrder: DateOrder): ImportedProject {
  const chat = parseChat(project.chatText, dateOrder);
  const attachmentStats = associateAttachments(chat.messages, project.assets);
  return { ...project, chat, attachmentStats };
}
