import JSZip, { type JSZipObject } from "jszip";
import { mediaKindFromFilename, mediaPresentationRole, parseChat, scoreChatText } from "./parser";
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
const MAX_SIGNATURE_PROBE_BYTES = 64 * 1024 * 1024;
const MAX_SIGNATURE_PROBE_TOTAL_BYTES = 192 * 1024 * 1024;
const ASSET_EXTENSION = /\.[a-z0-9]{1,16}$/iu;

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

function normalizeArchiveReference(value: string): string {
  return normalizeFilename(value.replace(/\\/gu, "/").replace(/^\.\//u, "")).replace(/^\/+|\/+$/gu, "");
}

function mimeForFilename(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const types: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", avif: "image/avif",
    bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
    webp: "image/webp", heic: "image/heic", heif: "image/heif",
    mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", webm: "video/webm", mkv: "video/x-matroska",
    "3gp": "video/3gpp", "3gpp": "video/3gpp",
    avi: "video/x-msvideo", mpeg: "video/mpeg", mpg: "video/mpeg", ogv: "video/ogg", mts: "video/mp2t", m2ts: "video/mp2t",
    wmv: "video/x-ms-wmv", flv: "video/x-flv",
    opus: "audio/opus", ogg: "audio/ogg", oga: "audio/ogg", m4a: "audio/mp4", mp3: "audio/mpeg", aac: "audio/aac", wav: "audio/wav",
    amr: "audio/amr", flac: "audio/flac", caf: "audio/x-caf", "3ga": "audio/3gpp", weba: "audio/webm",
    wma: "audio/x-ms-wma", aif: "audio/aiff", aiff: "audio/aiff",
    pdf: "application/pdf", doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    vcf: "text/vcard", vcard: "text/vcard", csv: "text/csv", rtf: "application/rtf",
    txt: "text/plain", md: "text/markdown", json: "application/json", xml: "application/xml", html: "text/html", htm: "text/html",
    ics: "text/calendar", eml: "message/rfc822", key: "application/vnd.apple.keynote", pages: "application/vnd.apple.pages",
    odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet",
    odp: "application/vnd.oasis.opendocument.presentation", epub: "application/epub+zip",
    zip: "application/zip", "7z": "application/x-7z-compressed", rar: "application/vnd.rar",
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

function isImportableAsset(entry: JSZipObject, chatEntry: JSZipObject): boolean {
  if (entry.name === chatEntry.name) return false;
  const normalized = entry.name.replace(/\\/gu, "/");
  const name = basename(normalized);
  return !normalized.split("/").includes("__MACOSX")
    && !/^(?:\.DS_Store|Thumbs\.db|desktop\.ini)$/iu.test(name)
    && !name.startsWith(".");
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

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

export function sniffMediaSignature(
  bytes: Uint8Array,
  filename = "",
): { kind: MediaKind; mimeType: string } | undefined {
  if (bytes.length < 4) return undefined;
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  const extension = filename.toLocaleLowerCase().split(".").pop() ?? "";
  if (starts(0xff, 0xd8, 0xff)) return { kind: "image", mimeType: "image/jpeg" };
  if (starts(0x89, 0x50, 0x4e, 0x47)) return { kind: "image", mimeType: "image/png" };
  if (ascii(bytes, 0, 4) === "GIF8") return { kind: "image", mimeType: "image/gif" };
  if (ascii(bytes, 0, 4) === "RIFF") {
    const format = ascii(bytes, 8, 4);
    if (format === "WEBP") return { kind: /(?:^|[\/\s_.-])(?:stk|sticker)(?:[\s_.-]|$)/iu.test(filename) ? "sticker" : "image", mimeType: "image/webp" };
    if (format === "WAVE") return { kind: "audio", mimeType: "audio/wav" };
    if (format === "AVI ") return { kind: "video", mimeType: "video/x-msvideo" };
  }
  if (ascii(bytes, 0, 4) === "OggS") return extension === "ogv" ? { kind: "video", mimeType: "video/ogg" } : { kind: "audio", mimeType: "audio/ogg" };
  if (ascii(bytes, 0, 4) === "fLaC") return { kind: "audio", mimeType: "audio/flac" };
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xf6) === 0xf0) return { kind: "audio", mimeType: "audio/aac" };
  if (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) {
    return { kind: "audio", mimeType: "audio/mpeg" };
  }
  if (ascii(bytes, 0, 5) === "#!AMR") return { kind: "audio", mimeType: "audio/amr" };
  if (ascii(bytes, 0, 4) === "caff") return { kind: "audio", mimeType: "audio/x-caf" };
  if (ascii(bytes, 0, 4) === "FORM" && ["AIFF", "AIFC"].includes(ascii(bytes, 8, 4))) return { kind: "audio", mimeType: "audio/aiff" };
  if (starts(0x1a, 0x45, 0xdf, 0xa3)) return extension === "weba" ? { kind: "audio", mimeType: "audio/webm" } : { kind: "video", mimeType: "video/webm" };
  if (starts(0x00, 0x00, 0x01, 0xba)) return { kind: "video", mimeType: "video/mpeg" };
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    const brands = ascii(bytes, 8, Math.min(24, bytes.length - 8)).toLocaleLowerCase();
    if (/(?:avif|avis|heic|heix|hevc|hevx|mif1|msf1)/u.test(brands)) {
      return { kind: "image", mimeType: brands.includes("avif") || brands.includes("avis") ? "image/avif" : "image/heic" };
    }
    if (extension === "3ga") return { kind: "audio", mimeType: "audio/3gpp" };
    if (["3gp", "3gpp"].includes(extension) || /3g(?:p|2)[a-z0-9 ]/u.test(brands)) return { kind: "video", mimeType: "video/3gpp" };
    if (["m4a", "m4b"].includes(extension) || /(?:m4a |m4b |f4a )/u.test(brands)) return { kind: "audio", mimeType: "audio/mp4" };
    return { kind: "video", mimeType: brands.includes("qt  ") ? "video/quicktime" : "video/mp4" };
  }
  return undefined;
}

async function probeReferencedAssetSignatures(messages: ChatMessage[], assets: ArchiveAsset[]): Promise<void> {
  const byPath = new Map(assets.map((asset) => [asset.path, asset]));
  const paths = [...new Set(messages
    .map((message) => message.attachment)
    .filter((attachment): attachment is Attachment => attachment?.status === "found")
    .map((attachment) => attachment.archivePath))];
  let remainingProbeBytes = MAX_SIGNATURE_PROBE_TOTAL_BYTES;
  for (const path of paths) {
    const asset = byPath.get(path);
    if (!asset || asset.size > MAX_SIGNATURE_PROBE_BYTES || asset.size > remainingProbeBytes) continue;
    remainingProbeBytes -= Math.max(64, asset.size);
    try {
      const blob = await asset.loadBlob();
      const bytes = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
      const detected = sniffMediaSignature(bytes, asset.basename);
      if (!detected) continue;
      asset.kind = detected.kind;
      asset.mimeType = detected.mimeType;
      for (const message of messages) {
        if (message.attachment?.archivePath !== path) continue;
        message.attachment.kind = detected.kind;
        message.attachment.mimeType = detected.mimeType;
        message.mediaHint = detected.kind;
        message.mediaRole = mediaPresentationRole(asset.basename, "", detected.kind);
      }
    } catch {
      // Signature probing is an enhancement; retain extension-based metadata
      // when a ZIP entry cannot be read here.
    }
  }
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
  const byPath = new Map<string, ArchiveAsset[]>();
  for (const asset of assets) {
    const current = byBasename.get(asset.normalizedBasename) ?? [];
    current.push(asset);
    byBasename.set(asset.normalizedBasename, current);
    const pathKey = normalizeArchiveReference(asset.path);
    const pathAssets = byPath.get(pathKey) ?? [];
    pathAssets.push(asset);
    byPath.set(pathKey, pathAssets);
  }
  const used = new Set<string>();
  let matched = 0;
  let missing = 0;
  let ambiguous = 0;

  for (const message of messages) {
    let reference = message.mediaReference;
    let inferredFromExactAssetName = false;
    if (!reference && message.kind === "text") {
      const candidate = (message.displayText ?? message.text).trim();
      if (!candidate.includes("\n") && ASSET_EXTENSION.test(candidate) && !/[\\/]/u.test(candidate)) {
        const matchingAssets = byBasename.get(normalizeFilename(candidate)) ?? [];
        if (matchingAssets.length) {
          reference = candidate;
          inferredFromExactAssetName = true;
        }
      }
    }
    if (!reference) continue;
    const normalizedReference = normalizeArchiveReference(reference);
    const normalized = normalizeFilename(basename(reference));
    const hasPathReference = normalizedReference.includes("/");
    const exactPathCandidates = hasPathReference
      ? byPath.get(normalizedReference) ?? []
      : [];
    const suffixPathCandidates = exactPathCandidates.length || !hasPathReference
      ? []
      : assets.filter((asset) => normalizeArchiveReference(asset.path).endsWith(`/${normalizedReference}`));
    const candidates = exactPathCandidates.length
      ? exactPathCandidates
      : suffixPathCandidates.length
        ? suffixPathCandidates
        : hasPathReference ? [] : byBasename.get(normalized) ?? [];
    if (candidates.length === 1 && candidates[0]) {
      message.attachment = attachmentFrom(candidates[0], "found");
      used.add(candidates[0].path);
      matched += 1;
    } else if (candidates.length > 1 && candidates[0]) {
      message.attachment = attachmentFrom(candidates[0], "ambiguous");
      ambiguous += 1;
    } else {
      message.attachment = missingAttachment(reference, message.mediaHint);
      missing += 1;
    }
    if (inferredFromExactAssetName && message.attachment) {
      message.kind = "media";
      message.mediaReference = reference;
      message.mediaHint = message.attachment.kind;
      message.mediaRole = mediaPresentationRole(reference, "", message.attachment.kind);
    }
  }

  // Omitted markers do not contain a filename or another stable identity.
  // ZIP order is not a reliable message mapping, so never guess an attachment.

  return { matched, missing, ambiguous, unreferenced: Math.max(0, assets.length - used.size) };
}

async function importTextFile(file: File, dateOrder: DateOrder): Promise<ImportedProject> {
  const chatText = await file.text();
  const chat = parseChat(chatText, dateOrder);
  if (!chat.messages.length) throw new Error("In der Textdatei wurden keine WhatsApp-Nachrichten erkannt.");
  const attachmentStats = associateAttachments(chat.messages, []);
  return {
    filename: file.name,
    chatFilename: file.name,
    chatText,
    chat,
    assets: [],
    attachmentStats,
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
    const contentScore = scoreChatText(text);
    const standardChatName = /(?:^|\/)(?:_(?:chat|conversation)|whatsapp chat(?: with| mit|\s*-)?[^\/]*)\.txt$/iu.test(entry.name);
    const namePriority = standardChatName && contentScore >= 10 ? 1_000_000 : 0;
    scored.push({ entry, text, score: contentScore + namePriority });
  }
  scored.sort((a, b) => b.score - a.score);
  const selected = scored[0];
  if (!selected || selected.score < 10) throw new Error("Die Textdateien im ZIP sehen nicht wie ein WhatsApp-Export aus.");

  const assets = entries.filter((entry) => isImportableAsset(entry, selected.entry)).map(makeAsset);
  const chat = parseChat(selected.text, dateOrder);
  if (!chat.messages.length) throw new Error("Es konnten keine Nachrichten aus dem WhatsApp-Export gelesen werden.");
  const attachmentStats = associateAttachments(chat.messages, assets);
  await probeReferencedAssetSignatures(chat.messages, assets);
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
