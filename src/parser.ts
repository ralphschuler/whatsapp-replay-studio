import type {
  ChatMessage,
  DateOrder,
  MediaKind,
  ParsedChat,
  ParseDiagnostics,
} from "./types";

const HEADER_CONTROL_CHARS = /^[\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]*/u;
const HEADER_PATTERN = /^(\d{1,4}\s*([./-])\s*\d{1,2}\s*\2\s*\d{1,4})\s*,?\s*(\d{1,2}([:.])\d{2}(?:\4\d{2})?)(?:[\s\u00A0\u202F]+([ap]\.?[\s\u00A0\u202F]*m\.?))?/iu;
const IOS_PATTERN = /^\[([^\]]+)\]\s*(.*)$/u;
const DASH_PATTERN = /^\s*(?:-|–|—)\s*(.*)$/u;
// iOS localizes this wrapper (for example "<Anhang: file.jpg>" in German).
// Match the structure instead of a fixed label, but require a filename extension
// so ordinary angle-bracket text is not mistaken for an attachment.
const ATTACHED_PATTERN = /<[^:>\n]{1,48}:\s*([^>\n]+\.(?:jpe?g|png|gif|webp|heic|heif|mp4|mov|m4v|webm|opus|ogg|m4a|mp3|aac|wav|pdf|docx?|xlsx?|pptx?|zip))>/iu;
const FILE_ATTACHED_PATTERN = /^(.+\.[a-z0-9]{2,8})\s+\((?:file attached|datei angehängt|datei angehaengt|angehängt|attached)\)/iu;
const GENERIC_FILENAME_PATTERN = /(?:^|\s)([^\n/\\]+\.(?:jpe?g|png|webp|gif|heic|heif|mp4|mov|m4v|webm|opus|ogg|m4a|mp3|aac|pdf|docx?|xlsx?|pptx?|zip))(?:\s|$)/iu;
const OMITTED_MARKERS: Array<[RegExp, MediaKind | undefined]> = [
  [/(?:image|photo|bild|foto) (?:omitted|weggelassen|nicht enthalten)/iu, "image"],
  [/(?:video) (?:omitted|weggelassen|nicht enthalten)/iu, "video"],
  [/(?:audio|sprachnachricht) (?:omitted|weggelassen|nicht enthalten)/iu, "audio"],
  [/(?:sticker) (?:omitted|weggelassen|nicht enthalten)/iu, "sticker"],
  [/<(?:media omitted|medien ausgeschlossen|medium weggelassen)>/iu, undefined],
];
const DELETED_MARKER = /^(?:you deleted this message|this message was deleted|du hast diese nachricht gelöscht|diese nachricht wurde gelöscht)$/iu;

interface RawHeader {
  date: string;
  time: string;
  ampm?: string;
  rest: string;
  rawTimestamp: string;
  precision: "minute" | "second";
}

interface RawRecord extends RawHeader {
  sourceOrder: number;
  continuation: string[];
}

function normalizeDigits(value: string): string {
  return value.replace(/[\u0660-\u0669\u06F0-\u06F9]/gu, (digit) => {
    const code = digit.codePointAt(0) ?? 0;
    if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
    return String(code - 0x06f0);
  });
}

function cleanHeaderStart(line: string): string {
  return normalizeDigits(line).replace(HEADER_CONTROL_CHARS, "");
}

export function readHeader(line: string): RawHeader | null {
  const clean = cleanHeaderStart(line);
  const ios = clean.match(IOS_PATTERN);
  let timestampPart: string;
  let rest: string;

  if (ios) {
    timestampPart = ios[1] ?? "";
    rest = ios[2] ?? "";
  } else {
    timestampPart = clean;
    rest = "";
  }

  const timeMatch = timestampPart.match(HEADER_PATTERN);
  if (!timeMatch || timeMatch.index !== 0) return null;

  if (!ios) {
    const afterTime = clean.slice(timeMatch[0].length);
    const dash = afterTime.match(DASH_PATTERN);
    if (!dash) return null;
    rest = dash[1] ?? "";
  } else if (timeMatch[0].length !== timestampPart.length) {
    return null;
  }

  return {
    date: (timeMatch[1] ?? "").replace(/\s/gu, ""),
    time: (timeMatch[3] ?? "").replaceAll(".", ":"),
    ampm: timeMatch[5]?.replace(/[\s.]/gu, "").toLowerCase(),
    rest,
    rawTimestamp: `${timeMatch[1] ?? ""} ${timeMatch[3] ?? ""}${timeMatch[5] ? ` ${timeMatch[5]}` : ""}`,
    precision: (timeMatch[3] ?? "").split(/[:.]/u).length === 3 ? "second" : "minute",
  };
}

function detectDateOrder(records: RawRecord[], requested: DateOrder): {
  order: Exclude<DateOrder, "auto">;
  ambiguous: boolean;
} {
  if (requested !== "auto") return { order: requested, ambiguous: false };

  let evidence: Exclude<DateOrder, "auto"> | null = null;
  let conflict = false;

  for (const record of records.slice(0, 500)) {
    const parts = record.date.split(/[./-]/u).map(Number);
    const [a = 0, b = 0] = parts;
    let candidate: Exclude<DateOrder, "auto"> | null = null;
    if (String(parts[0] ?? "").length === 4 || a > 31) candidate = "ymd";
    else if (a > 12 && b <= 12) candidate = "dmy";
    else if (b > 12 && a <= 12) candidate = "mdy";
    else if (record.date.includes(".")) candidate = "dmy";

    if (candidate && evidence && evidence !== candidate) conflict = true;
    if (candidate && !evidence) evidence = candidate;
  }

  return { order: evidence ?? "dmy", ambiguous: evidence === null || conflict };
}

function parseTimestamp(
  header: RawHeader,
  order: Exclude<DateOrder, "auto">,
): Date | null {
  const dateParts = header.date.split(/[./-]/u).map(Number);
  if (dateParts.length !== 3) return null;
  let year: number;
  let month: number;
  let day: number;
  const [a = 0, b = 0, c = 0] = dateParts;
  if (order === "dmy") [day, month, year] = [a, b, c];
  else if (order === "mdy") [month, day, year] = [a, b, c];
  else [year, month, day] = [a, b, c];
  if (year < 100) year += 2000;

  const timeParts = header.time.split(":").map(Number);
  let hour = timeParts[0] ?? -1;
  const minute = timeParts[1] ?? -1;
  const second = timeParts[2] ?? 0;
  if (header.ampm) {
    if (hour < 1 || hour > 12) return null;
    if (header.ampm.startsWith("p") && hour !== 12) hour += 12;
    if (header.ampm.startsWith("a") && hour === 12) hour = 0;
  }
  if (year < 1970 || year > 2200 || month < 1 || month > 12 || day < 1 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;

  const parsed = new Date(year, month - 1, day, hour, minute, second, 0);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day ||
    parsed.getHours() !== hour ||
    parsed.getMinutes() !== minute ||
    parsed.getSeconds() !== second
  ) return null;
  return parsed;
}

function splitSender(rest: string): { sender: string | null; text: string } {
  const match = rest.match(/^(.{1,120}?):(?:\s|$)([\s\S]*)$/u);
  if (!match) return { sender: null, text: rest };
  const sender = (match[1] ?? "").trim();
  if (!sender || /^(?:https?|ftp)$/iu.test(sender)) return { sender: null, text: rest };
  return { sender, text: match[2] ?? "" };
}

function classifyMessage(text: string, sender: string | null): Pick<ChatMessage, "kind" | "mediaHint" | "mediaReference"> {
  const attached = text.match(ATTACHED_PATTERN) ?? text.match(FILE_ATTACHED_PATTERN);
  const filename = attached?.[1] ?? text.match(GENERIC_FILENAME_PATTERN)?.[1];
  if (filename) {
    return { kind: "media", mediaHint: mediaKindFromFilename(filename), mediaReference: filename.trim() };
  }
  for (const [pattern, hint] of OMITTED_MARKERS) {
    if (pattern.test(text)) return { kind: "media-omitted", mediaHint: hint };
  }
  if (DELETED_MARKER.test(text.trim())) return { kind: "deleted" };
  return { kind: sender ? "text" : "system" };
}

export function mediaKindFromFilename(filename: string): MediaKind {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (["jpg", "jpeg", "png", "gif", "heic", "heif"].includes(ext)) return "image";
  if (ext === "webp") return /(?:stk|sticker)/iu.test(filename) ? "sticker" : "image";
  if (["mp4", "mov", "m4v", "webm"].includes(ext)) return "video";
  if (["opus", "ogg", "m4a", "mp3", "aac", "wav"].includes(ext)) return "audio";
  return "document";
}

export function parseChat(text: string, requestedOrder: DateOrder = "auto"): ParsedChat {
  const normalized = text.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  const records: RawRecord[] = [];
  const preamble: string[] = [];
  let current: RawRecord | null = null;

  for (const line of lines) {
    const header = readHeader(line);
    if (header) {
      if (current) records.push(current);
      current = { ...header, sourceOrder: records.length, continuation: [] };
    } else if (current) {
      current.continuation.push(line);
    } else if (line.length > 0) {
      preamble.push(line);
    }
  }
  if (current) records.push(current);

  const detected = detectDateOrder(records, requestedOrder);
  const messages: ChatMessage[] = [];
  let invalidTimestampLines = 0;
  let reversedTimestamps = 0;

  for (const record of records) {
    const timestamp = parseTimestamp(record, detected.order);
    if (!timestamp) {
      invalidTimestampLines += 1;
      continue;
    }
    const { sender, text: firstLine } = splitSender(record.rest);
    const body = [firstLine, ...record.continuation].join("\n").replace(/\n+$/u, "");
    const classification = classifyMessage(body, sender);
    const previous = messages[messages.length - 1];
    const warnings: string[] = [];
    if (previous && timestamp.getTime() < previous.timestamp.getTime()) {
      reversedTimestamps += 1;
      warnings.push("Zeitstempel liegt vor der vorherigen Nachricht; Quelldateireihenfolge bleibt erhalten.");
    }
    messages.push({
      id: `msg-${record.sourceOrder}`,
      sourceOrder: record.sourceOrder,
      timestamp,
      rawTimestamp: record.rawTimestamp,
      precision: record.precision,
      sender,
      text: body,
      ...classification,
      warnings,
    });
  }

  const participants = [...new Set(messages.map((message) => message.sender).filter((sender): sender is string => Boolean(sender)))];
  const warnings: string[] = [];
  if (detected.ambiguous) warnings.push("Das Datumsformat ist nicht eindeutig. Bitte die Vorschau prüfen.");
  if (reversedTimestamps) warnings.push(`${reversedTimestamps} rückwärts laufende Zeitstempel erkannt; die Exportreihenfolge wurde beibehalten.`);
  const diagnostics: ParseDiagnostics = {
    totalLines: lines.length,
    parsedMessages: messages.length,
    unparsedPreambleLines: preamble.length,
    invalidTimestampLines,
    dateOrder: detected.order,
    dateOrderAmbiguous: detected.ambiguous,
    reversedTimestamps,
    warnings,
  };
  return { messages, participants, preamble, diagnostics };
}

export function scoreChatText(text: string): number {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  if (!lines.length) return 0;
  const sample = lines.slice(0, 3000);
  const matches = sample.reduce((count, line) => count + (readHeader(line) ? 1 : 0), 0);
  return matches * 10 + matches / sample.length;
}
