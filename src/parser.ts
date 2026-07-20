import type {
  ChatMessage,
  DateOrder,
  MediaKind,
  MediaPresentationRole,
  MessageSemantic,
  ParsedChat,
  ParseDiagnostics,
} from "./types";

const HEADER_CONTROL_CHARS = /^[\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]*/u;
const HEADER_PATTERN = /^(\d{1,4}\s*([./-])\s*\d{1,2}\s*\2\s*\d{1,4})\s*,?\s*(\d{1,2}([:.])\d{2}(?:\4\d{2})?)(?:[\s\u00A0\u202F]+([ap]\.?[\s\u00A0\u202F]*m\.?))?/iu;
const IOS_PATTERN = /^\[([^\]]+)\]\s*(.*)$/u;
const DASH_PATTERN = /^\s*(?:-|–|—)\s*(.*)$/u;
// WhatsApp's iOS export uses "attached" in English and "Anhang" in German.
// Restrict the label as well as the extension so ordinary angle-bracket text
// such as "<Hinweis: report.pdf>" remains a normal chat message.
const ATTACHED_PATTERN = /<(?:attached|attachment|anhang|datei|angehängt|angehaengt):\s*([^>\n]{1,255}?)\s*>/iu;
const FILE_ATTACHED_PATTERN = /^([^\n]{1,255}?)\s+\((?:file attached|datei angehängt|datei angehaengt|angehängt|attached)\)/iu;
const ALL_ATTACHED_PATTERN = /<(?:attached|attachment|anhang|datei|angehängt|angehaengt):\s*([^>\n]{1,255}?)\s*>/giu;
const ALL_FILE_ATTACHED_PATTERN = /^([^\n]{1,255}?)\s+\((?:file attached|datei angehängt|datei angehaengt|angehängt|attached)\)/gimu;
const OMITTED_MARKERS: Array<[RegExp, MediaKind | undefined]> = [
  [/^[\u200E\u200F]*<\s*(?:image|photo|bild|foto)\s+(?:omitted|weggelassen|nicht enthalten)\s*>[.!]?(?:\n[\s\S]*)?$/iu, "image"],
  [/^[\u200E\u200F]*(?:image|photo|bild|foto)\s+(?:omitted|weggelassen|nicht enthalten)[.!]?(?:\n[\s\S]*)?$/iu, "image"],
  [/^[\u200E\u200F]*<\s*(?:video(?: message| note)?|videonachricht|videonotiz)\s+(?:omitted|weggelassen|nicht enthalten)\s*>[.!]?(?:\n[\s\S]*)?$/iu, "video"],
  [/^[\u200E\u200F]*(?:video(?: message| note)?|videonachricht|videonotiz)\s+(?:omitted|weggelassen|nicht enthalten)[.!]?(?:\n[\s\S]*)?$/iu, "video"],
  [/^[\u200E\u200F]*<\s*(?:audio|voice message|sprachnachricht)\s+(?:omitted|weggelassen|nicht enthalten)\s*>[.!]?(?:\n[\s\S]*)?$/iu, "audio"],
  [/^[\u200E\u200F]*(?:audio|voice message|sprachnachricht)\s+(?:omitted|weggelassen|nicht enthalten)[.!]?(?:\n[\s\S]*)?$/iu, "audio"],
  [/^[\u200E\u200F]*<\s*sticker\s+(?:omitted|weggelassen|nicht enthalten)\s*>[.!]?(?:\n[\s\S]*)?$/iu, "sticker"],
  [/^[\u200E\u200F]*sticker\s+(?:omitted|weggelassen|nicht enthalten)[.!]?(?:\n[\s\S]*)?$/iu, "sticker"],
  [/^[\u200E\u200F]*<\s*(?:gif|animated image|animiertes bild)\s+(?:omitted|weggelassen|nicht enthalten)\s*>[.!]?(?:\n[\s\S]*)?$/iu, "image"],
  [/^[\u200E\u200F]*(?:gif|animated image|animiertes bild)\s+(?:omitted|weggelassen|nicht enthalten)[.!]?(?:\n[\s\S]*)?$/iu, "image"],
  [/^[\u200E\u200F]*<\s*(?:document|dokument|contact card|kontaktkarte)\s+(?:omitted|weggelassen|nicht enthalten|ausgelassen)\s*>[.!]?(?:\n[\s\S]*)?$/iu, "document"],
  [/^[\u200E\u200F]*(?:document|dokument|contact card|kontaktkarte)\s+(?:omitted|weggelassen|nicht enthalten|ausgelassen)[.!]?(?:\n[\s\S]*)?$/iu, "document"],
  [/^[\u200E\u200F]*(?:<\s*)?[^<>\n]{1,220}\.[a-z0-9]{1,16}(?:(?:\s*[•·]\s*\d+\s+(?:pages?|seiten?))?\s+(?:document|dokument))?\s+(?:omitted|weggelassen|ausgelassen|nicht enthalten)(?:\s*>)?[.!]?(?:\n[\s\S]*)?$/iu, "document"],
  [/^[\u200E\u200F]*<\s*(?:media omitted|medien (?:ausgeschlossen|weggelassen|nicht enthalten)|medium weggelassen)\s*>[.!]?(?:\n[\s\S]*)?$/iu, undefined],
];
const DELETED_MARKER = /^[\u200E\u200F]*(?:message deleted|you deleted this message(?: as an admin| for everyone)?|this message was deleted(?: for everyone| by (?:an admin|.+?))?|du hast diese nachricht(?: als admin| für alle)? gelöscht|diese nachricht wurde(?: für alle| von (?:einem admin|.+?))? gelöscht|.+? deleted this message as an admin|.+? hat diese nachricht als admin gelöscht)[.!]?[\u200E\u200F]*$/iu;
const VIEW_ONCE_MARKER = /^[\u200E\u200F]*(?:<\s*)?(?:view once (?:photo|image|video|voice message|audio|media|text) (?:omitted|excluded|not available|opened)|view once (?:voice message|audio) listened to|(?:photo|image|video|voice message|audio|media|text) set to view once|(?:foto|bild|video|sprachnachricht|audio|medium|text) zur einmaligen ansicht (?:ausgeschlossen|nicht verfügbar|weggelassen|geöffnet)|(?:sprachnachricht|audio) zur einmaligen ansicht (?:angehört|abgehört)|einmalansicht[- ](?:foto|bild|video|sprachnachricht|audio|medium|text) (?:nicht verfügbar|weggelassen|geöffnet|angehört))(?:\s*>)?[.!]?[\u200E\u200F]*$/iu;
const UNSUPPORTED_MARKER = /^[\u200E\u200F]*<?(?:waiting for this message\. this may take a while|warte[n]? auf diese nachricht\. das kann einen moment dauern|(?:this )?message unavailable|nachricht nicht verfügbar|this message is (?:not supported on this version of whatsapp|unavailable)|diese nachricht (?:wird in dieser whatsapp-version nicht unterstützt|ist nicht verfügbar)|you received a message but your version of whatsapp doesn['’]t support it(?:\. update whatsapp to view this message)?|du hast eine nachricht erhalten, aber deine whatsapp-version unterstützt sie nicht(?:\. aktualisiere whatsapp, um diese nachricht anzusehen)?|this message was edited for everyone in this chat on the latest version of whatsapp|diese nachricht wurde für alle in diesem chat in der neuesten whatsapp-version bearbeitet)>?[.!]?[\u200E\u200F]*$/iu;
const EXPIRED_MESSAGE_MARKER = /^[\u200E\u200F]*<?(?:disappearing message expired|expired disappearing message|selbstlöschende nachricht abgelaufen)>?[.!]?[\u200E\u200F]*$/iu;

interface MessageDecorations {
  content: string;
  forwarded?: boolean;
  frequentlyForwarded?: boolean;
  edited?: boolean;
  quotedText?: string;
}

export interface ExplicitAttachmentReference {
  filename: string;
  start: number;
  end: number;
}

export function extractExplicitAttachmentReferences(text: string): ExplicitAttachmentReference[] {
  const references: ExplicitAttachmentReference[] = [];
  for (const match of text.matchAll(ALL_ATTACHED_PATTERN)) {
    if (match.index === undefined || !match[1]?.trim()) continue;
    references.push({ filename: match[1].trim(), start: match.index, end: match.index + match[0].length });
  }
  for (const match of text.matchAll(ALL_FILE_ATTACHED_PATTERN)) {
    if (match.index === undefined || !match[1]?.trim()) continue;
    references.push({ filename: match[1].trim(), start: match.index, end: match.index + match[0].length });
  }
  references.sort((a, b) => a.start - b.start || a.end - b.end);
  return references.filter((reference, index) => {
    const previous = references[index - 1];
    return !previous || reference.start >= previous.end;
  });
}

export function stripExplicitAttachmentMarkers(text: string): string {
  const references = extractExplicitAttachmentReferences(text);
  if (!references.length) return text;
  let cursor = 0;
  let result = "";
  for (const reference of references) {
    result += text.slice(cursor, reference.start);
    cursor = reference.end;
  }
  result += text.slice(cursor);
  return result
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, "")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n[ \t]+/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function markerText(value: string): string {
  return value.replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, "").trim();
}

function extractDecorations(text: string): MessageDecorations {
  let content = text;
  let forwarded = false;
  let frequentlyForwarded = false;
  let edited = false;
  let quotedText: string | undefined;

  const forwardedMatch = markerText(content).match(/^(forwarded(?: message| many times)?|frequently forwarded|weitergeleitet(?:e nachricht)?|häufig weitergeleitet)[.:]?\s*(?:\n+|\s+-\s+)([\s\S]+)$/iu);
  if (forwardedMatch?.[2]) {
    forwarded = true;
    frequentlyForwarded = /many times|frequently|häufig/iu.test(forwardedMatch[1] ?? "");
    content = forwardedMatch[2].trim();
  }

  const editedMatch = content.match(/^([\s\S]+?)(?:\n|\s+)[\u200E\u200F]*(?:<|\[)(?:edited|bearbeitet|this message was edited|diese nachricht wurde bearbeitet)(?:>|\])[\u200E\u200F]*\s*$/iu);
  if (editedMatch?.[1]?.trim()) {
    edited = true;
    content = editedMatch[1].trimEnd();
  }

  const lines = content.split("\n");
  const quoteLines: string[] = [];
  while (lines.length && /^\s*(?:>|│)\s?/u.test(lines[0] ?? "")) {
    quoteLines.push((lines.shift() ?? "").replace(/^\s*(?:>|│)\s?/u, ""));
  }
  while (lines[0] === "") lines.shift();
  if (quoteLines.length && lines.some((line) => line.trim())) {
    quotedText = quoteLines.join("\n").trim();
    content = lines.join("\n").trimStart();
  }

  return {
    content,
    forwarded: forwarded || undefined,
    frequentlyForwarded: frequentlyForwarded || undefined,
    edited: edited || undefined,
    quotedText,
  };
}

function callSemantic(text: string): MessageSemantic | undefined {
  const clean = markerText(text);
  const english = clean.match(/^(?:you\s+)?(?:(missed|declined|cancelled|canceled|unanswered|incoming|outgoing)\s+)?(?:an?\s+)?(?:group\s+)?(voice|video)\s+call(?:\s*[,·.\u2013\u2014-]\s*(.+))?$/iu);
  const german = clean.match(/^(?:du hast (?:einen|den)\s+)?(?:(verpasst(?:er|e|es|en)?|abgelehnt(?:er|e|es|en)?|abgebrochen(?:er|e|es|en)?|nicht angenommen(?:er|e|es|en)?|eingehend(?:er|e|es|en)?|ausgehend(?:er|e|es|en)?)\s+)?(?:gruppen[- ]?)?(sprach|video)anruf(?:\s*[,·.\u2013\u2014-]\s*(.+))?$/iu);
  const germanTrailingStatus = clean.match(/^(?:du hast (?:einen|den)\s+)?(?:gruppen[- ]?)?(sprach|video)anruf\s+(verpasst|abgelehnt|abgebrochen)(?:\s*[,·.\u2013\u2014-]\s*(.+))?$/iu);
  const generic = clean.match(/^(missed call|verpasster anruf)(?:\s*[,·.\u2013\u2014-]\s*(.+))?$/iu);
  if (!english && !german && !germanTrailingStatus && !generic) return undefined;
  const statusToken = (english?.[1] ?? german?.[1] ?? germanTrailingStatus?.[2] ?? (generic ? "missed" : "")).toLocaleLowerCase();
  const modeToken = (english?.[2] ?? german?.[2] ?? germanTrailingStatus?.[1] ?? "voice").toLocaleLowerCase();
  const missed = /missed|verpasst/iu.test(statusToken);
  const declined = /declined|abgelehnt/iu.test(statusToken);
  const cancelled = /cancel|abgebrochen|unanswered|nicht angenommen/iu.test(statusToken);
  const incoming = /incoming|eingehend/iu.test(statusToken);
  const outgoing = /outgoing|ausgehend/iu.test(statusToken);
  const mode = /video/iu.test(modeToken) ? "video" : "voice";
  const prefix = missed ? "Verpasster" : declined ? "Abgelehnter" : cancelled ? "Nicht angenommener" : incoming ? "Eingehender" : outgoing ? "Ausgehender" : "";
  return {
    type: "call",
    variant: `${missed ? "missed" : declined ? "declined" : cancelled ? "cancelled" : incoming ? "incoming" : outgoing ? "outgoing" : "completed"}-${mode}`,
    title: `${prefix ? `${prefix} ` : ""}${mode === "video" ? "Videoanruf" : "Sprachanruf"}`,
    detail: english?.[3]?.trim() ?? german?.[3]?.trim() ?? germanTrailingStatus?.[3]?.trim() ?? generic?.[2]?.trim(),
  };
}

function locationSemantic(text: string): MessageSemantic | undefined {
  const clean = markerText(text);
  const namedFoursquareVenue = clean.match(/^(.{1,500}?)\s*:\s*(https?:\/\/(?:www\.)?foursquare\.com\/v\/\S+)$/iu);
  if (namedFoursquareVenue) {
    return {
      type: "location",
      variant: "venue",
      title: "Standort",
      detail: "Kartenlink",
      body: namedFoursquareVenue[1]?.trim(),
    };
  }
  const mapLink = clean.match(/(?:https?:\/\/(?:www\.)?(?:maps\.google\.[^\s/]+|google\.[^\s/]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps|maps\.apple\.com)\/[^\s]*|geo:-?\d{1,3}(?:\.\d+)?,-?\d{1,3}(?:\.\d+)?)/iu)?.[0];
  const droppedPin = Boolean(mapLink) && /^dropped pin(?:\s|$)/iu.test(clean);
  const explicit = droppedPin || /^(?:📍\s*)?(?:live[- ]location|live-standort|location|standort)(?:\s+(?:shared|geteilt|wird geteilt|is being shared))?[.!]?\s*(?::|-|$)/iu.test(clean);
  const remainderWithoutLink = mapLink ? clean.replace(mapLink, "").trim() : "";
  const standaloneMapLink = Boolean(mapLink) && (!remainderWithoutLink || /^(?:📍|treffpunkt|meeting point)\s*:?\s*$/iu.test(remainderWithoutLink));
  if (!explicit && !standaloneMapLink) return undefined;
  let decoded = clean;
  try { decoded = decodeURIComponent(clean); } catch { /* Keep the original marker text. */ }
  const coordinateMatch = decoded.match(/(?:[?&](?:q|query|ll)=|geo:)(-?\d{1,3}(?:\.\d+)?)[,\s]+(-?\d{1,3}(?:\.\d+)?)/iu);
  const latitude = Number(coordinateMatch?.[1]);
  const longitude = Number(coordinateMatch?.[2]);
  const validCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
  const body = clean
    .replace(mapLink ?? /$^/u, "")
    .replace(/^dropped pin[.!]?\s*/iu, "")
    .replace(/^(?:📍\s*)?(?:live[- ]location|live-standort|location|standort)(?:\s+(?:shared|geteilt|wird geteilt|is being shared))?[.!]?\s*(?::|-)?\s*/iu, "")
    .trim();
  const live = /live[- ]location|live-standort/iu.test(clean);
  return {
    type: "location",
    variant: live ? "live" : "pin",
    title: live ? "Live-Standort" : "Standort",
    detail: validCoordinates ? `${latitude.toFixed(5)}, ${longitude.toFixed(5)}` : mapLink ? "Kartenlink" : undefined,
    body: body || undefined,
  };
}

function pollSemantic(text: string): MessageSemantic | undefined {
  const lines = markerText(text).split("\n").map((line) => line.trim()).filter(Boolean);
  const heading = lines[0]?.match(/^(?:📊\s*)?(?:poll|umfrage)(?:\s+created|\s+erstellt)?\s*(?::|-)?\s*(.*)$/iu);
  if (!heading) {
    const localizedHeading = lines[0]?.match(/^[\p{Lu}\p{M}][\p{Lu}\p{M}\s-]{2,30}:$/u);
    if (!localizedHeading || lines.length < 4) return undefined;
    const localizedOptions = lines.slice(2).map((line) => line.match(/^([\p{Lu}\p{M}][\p{Lu}\p{M}\s-]{1,30})\s*:\s*(.+\(\d+\s+[^)]+\))$/u));
    const labels = new Set(localizedOptions.map((match) => match?.[1]?.normalize("NFC")));
    if (localizedOptions.length < 2 || localizedOptions.some((match) => !match?.[2]) || labels.size !== 1) return undefined;
    return {
      type: "poll",
      title: "Umfrage",
      detail: lines[1],
      items: localizedOptions.map((match) => match?.[2] ?? ""),
    };
  }
  const inlineQuestion = heading[1]?.trim();
  const question = inlineQuestion || lines[1]?.replace(/^\s*(?:(?:question|frage)\s*(?::|-)|(?:[-*•○◯]|\d+[.)])\s*)/iu, "").trim() || "Umfrage";
  const optionStart = inlineQuestion ? 1 : 2;
  const items = lines.slice(optionStart)
    .map((line) => line.replace(/^\s*(?:(?:option|antwort)\s*(?::|-)|(?:[-*•○◯]|\d+[.)])\s*)/iu, "").trim())
    .filter(Boolean);
  if (items.length < 2) return undefined;
  return { type: "poll", title: "Umfrage", detail: question, items };
}

function reactionSemantic(text: string): MessageSemantic | undefined {
  const clean = markerText(text);
  const removedEnglish = clean.match(/^(?:you\s+)?removed\s+(?:your\s+)?reaction\s+(.+?)\s+from\s+["“']?(.+?)["”']?$/iu);
  const removedGerman = clean.match(/^(?:du\s+)?(?:hast\s+)?(?:deine\s+)?reaktion\s+(.+?)\s+von\s+[„"']?(.+?)[“"']?\s+entfernt$/iu);
  if (removedEnglish || removedGerman) {
    return {
      type: "reaction",
      variant: "removed",
      title: "Reaktion entfernt",
      detail: (removedEnglish?.[1] ?? removedGerman?.[1] ?? "").trim(),
      body: (removedEnglish?.[2] ?? removedGerman?.[2] ?? "").trim(),
    };
  }
  const english = clean.match(/^(?:you\s+)?reacted\s+(.+?)\s+to\s+(?:your\s+message\s+)?["“']?(.+?)["”']?$/iu);
  const german = clean.match(/^(?:du\s+)?(?:hast\s+)?mit\s+(.+?)\s+auf\s+(?:deine\s+nachricht\s+)?[„"']?(.+?)[“"']?\s+reagiert$/iu);
  if (!english && !german) return undefined;
  return {
    type: "reaction",
    title: "Reaktion",
    detail: (english?.[1] ?? german?.[1] ?? "").trim(),
    body: (english?.[2] ?? german?.[2] ?? "").trim(),
  };
}

function contactSemantic(text: string): MessageSemantic | undefined {
  const clean = markerText(text);
  const card = clean.match(/^(?:👤\s*)?(?:contact card|kontaktkarte)(?:\s+(?:shared|geteilt))?(?:\s*(?::|-)\s*(.*))?$/iu);
  const shared = clean.match(/^(?:👤\s*)?(?:contact|kontakt)\s+(?:shared|geteilt)(?:\s*(?::|-)\s*(.*))?$/iu);
  const detail = card?.[1] ?? shared?.[1];
  if (!card && !shared) return undefined;
  return { type: "contact", title: "Kontakt", detail: detail?.trim() || "Geteilte Kontaktkarte" };
}

function paymentSemantic(text: string): MessageSemantic | undefined {
  const clean = markerText(text);
  const lines = clean.split("\n").map((line) => line.trim()).filter(Boolean);
  const first = lines[0] ?? "";
  const withStatus = first.match(/^(?:💳\s*)?(?:payment|zahlung)\s+(sent|received|failed|requested|pending|cancelled|canceled|expired|refunded|gesendet|erhalten|fehlgeschlagen|angefordert|ausstehend|storniert|abgebrochen|abgelaufen|erstattet)(?:\s*(?::|-)\s*|\s+)?(.*)$/iu);
  const labeled = first.match(/^(?:💳\s*)?(?:payment|zahlung)\s*(?::|-)\s*(.+)$/iu);
  const structuredHeading = /^(?:💳\s*)?(?:payment|zahlung)$/iu.test(first);
  const structuredStatus = lines.slice(1).find((line) => /^(?:status|status der zahlung)\s*(?::|-)\s*(?:sent|received|failed|requested|pending|cancelled|canceled|expired|refunded|gesendet|erhalten|fehlgeschlagen|angefordert|ausstehend|storniert|abgebrochen|abgelaufen|erstattet)$/iu.test(line));
  const structuredAmount = lines.slice(1).find((line) => /^(?:amount|betrag|total|summe)\s*(?::|-)\s*.+$/iu.test(line));
  const amountValue = (withStatus?.[2] ?? labeled?.[1] ?? structuredAmount?.replace(/^[^:-]+(?::|-)\s*/u, ""))?.trim() ?? "";
  const monetaryAmount = /(?:[$€£¥₹₽₩]\s*[-+]?[\d.,' ]+|(?:AED|AUD|BRL|CAD|CHF|CNY|EUR|GBP|INR|JPY|KRW|MXN|NGN|RUB|SAR|TRY|USD|ZAR)\s*[-+]?[\d.,' ]+|[-+]?[\d.,' ]+\s*(?:AED|AUD|BRL|CAD|CHF|CNY|EUR|GBP|INR|JPY|KRW|MXN|NGN|RUB|SAR|TRY|USD|ZAR|[$€£¥₹₽₩]))/iu.test(amountValue);
  // A bare label is ordinary prose surprisingly often ("Payment: due Friday").
  // Explicit exported statuses are strong markers; otherwise require an amount.
  if (!withStatus && !(labeled && monetaryAmount) && !(structuredHeading && structuredStatus && structuredAmount && monetaryAmount)) return undefined;
  const status = (withStatus?.[1] ?? structuredStatus?.replace(/^[^:-]+(?::|-)\s*/u, "") ?? "").toLocaleLowerCase();
  const variant = /failed|fehlgeschlagen/iu.test(status) ? "failed"
    : /received|erhalten/iu.test(status) ? "received"
      : /requested|angefordert/iu.test(status) ? "requested"
        : /pending|ausstehend/iu.test(status) ? "pending"
          : /cancelled|canceled|storniert|abgebrochen/iu.test(status) ? "cancelled"
            : /expired|abgelaufen/iu.test(status) ? "expired"
              : /refunded|erstattet/iu.test(status) ? "refunded" : "sent";
  const titles: Record<string, string> = {
    failed: "Zahlung fehlgeschlagen",
    received: "Zahlung erhalten",
    requested: "Zahlung angefordert",
    pending: "Zahlung ausstehend",
    cancelled: "Zahlung storniert",
    expired: "Zahlungsanfrage abgelaufen",
    refunded: "Zahlung erstattet",
    sent: "Zahlung gesendet",
  };
  return {
    type: "payment",
    variant,
    title: titles[variant] ?? "Zahlung",
    detail: amountValue || undefined,
    items: lines.length > 1 ? lines.slice(1) : undefined,
  };
}

function structuredEventSemantic(text: string): MessageSemantic | undefined {
  const lines = markerText(text).split("\n").map((line) => line.trim()).filter(Boolean);
  const lifecycle = lines[0]?.match(/^(?:event|ereignis)[ -](updated|cancelled|canceled|reminder|aktualisiert|abgesagt|erinnerung)\s*(?::|-)\s*(.+)$/iu)
    ?? lines[0]?.match(/^(event reminder|ereigniserinnerung)\s*(?::|-)\s*(.+)$/iu);
  if (lifecycle) {
    const token = lifecycle[1]?.toLocaleLowerCase() ?? "";
    const variant = /cancel|abgesagt/iu.test(token) ? "event-cancelled" : /reminder|erinnerung/iu.test(token) ? "event-reminder" : "event-updated";
    return {
      type: "event",
      variant,
      title: variant === "event-cancelled" ? "Ereignis abgesagt" : variant === "event-reminder" ? "Ereigniserinnerung" : "Ereignis aktualisiert",
      detail: lifecycle[2]?.trim(),
      items: lines.slice(1),
    };
  }
  const response = lines[0]?.match(/^(?:rsvp|event response|ereignisantwort|event-antwort)\s*(?::|-)\s*(going|not going|maybe|zugesagt|abgesagt|vielleicht)(?:\s*(?::|-)\s*(.*))?$/iu);
  if (response) {
    const status = response[1]?.toLocaleLowerCase() ?? "";
    const variant = /not going|abgesagt/iu.test(status) ? "rsvp-declined" : /maybe|vielleicht/iu.test(status) ? "rsvp-maybe" : "rsvp-going";
    return {
      type: "event",
      variant,
      title: variant === "rsvp-going" ? "Ereignis zugesagt" : variant === "rsvp-declined" ? "Ereignis abgesagt" : "Ereignis: vielleicht",
      detail: response[2]?.trim() || lines[1],
      items: lines.slice(response[2]?.trim() ? 1 : 2),
    };
  }
  const heading = lines[0]?.match(/^(?:📅\s*)?(?:event|ereignis)(?:\s+(?:created|erstellt))?(?:\s*(?::|-)\s*(.*))?$/iu);
  if (!heading || lines.length < 2) return undefined;
  const details = lines.slice(1);
  const structuredDetails = details.filter((line) => /^(?:(?:event\s+)?(?:name|title|date|start(?:\s+time)?|end(?:\s+time)?|cancelled|description|location(?:\s+(?:name|point))?|join\s+link)|titel|datum|start|ende|zeit|wann|all[ -]?day|ganztägig|ort|wo|organizer|organisator|beschreibung|url|link|beitrittslink|startzeit des ereignisses|ereignis abgesagt|beschreibung des ereignisses|beitrittslink des ereignisses|standortname des ereignisses|genauer standort des ereignisses)\s*(?::|-)/iu.test(line));
  const inlineTitle = heading[1]?.trim();
  if (inlineTitle ? structuredDetails.length < 1 : structuredDetails.length < 2) return undefined;
  const namedDetail = details.find((line) => /^(?:(?:event\s+)?(?:name|title)|titel)\s*(?::|-)/iu.test(line))?.replace(/^(?:(?:event\s+)?(?:name|title)|titel)\s*(?::|-)\s*/iu, "").trim();
  return {
    type: "event",
    variant: "chat-event",
    title: "Ereignis",
    detail: inlineTitle || namedDetail,
    items: details,
  };
}

function templateSemantic(text: string): MessageSemantic | undefined {
  const lines = markerText(text).split("\n").map((line) => line.trim()).filter(Boolean);
  const heading = lines[0]?.match(/^(?:template message|message template|nachrichtenvorlage|vorlagennachricht)(?:\s*(?::|-)\s*(.+))?$/iu);
  if (!heading || lines.length < 3) return undefined;
  const fields = lines.slice(1).filter((line) => /^(?:template[ -]?(?:id|name)|vorlagen[ -]?(?:id|name)|language|sprache|header|kopfzeile|body|text|footer|fußzeile|button|schaltfläche|action|aktion|code|media|medium)\s*(?::|-)/iu.test(line));
  if (fields.length < 2) return undefined;
  const namedField = fields.find((line) => /^(?:template[ -]?name|vorlagen[ -]?name)\s*(?::|-)/iu.test(line))?.replace(/^[^:-]+(?::|-)\s*/u, "").trim();
  return {
    type: "template",
    variant: "structured-template",
    title: "Nachrichtenvorlage",
    detail: heading[1]?.trim() || namedField,
    items: lines.slice(1),
  };
}

function businessSemantic(text: string): MessageSemantic | undefined {
  const lines = markerText(text).split("\n").map((line) => line.trim()).filter(Boolean);
  const richHeading = lines[0]?.match(/^(catalog message|katalognachricht|product list message|produktlistennachricht|multi-product message|multi-produkt-nachricht|product inquiry|produktanfrage|referred product|empfohlenes produkt|referral message|referral-nachricht)(?:\s*(?::|-)\s*(.+))?$/iu);
  if (richHeading) {
    const token = richHeading[1]?.toLocaleLowerCase() ?? "";
    const variant = /product list|produktliste|multi-product|multi-produkt/iu.test(token)
      ? "product-list"
      : /inquiry|anfrage/iu.test(token)
        ? "product-inquiry"
        : /referred product|empfohlenes produkt/iu.test(token)
          ? "referred-product"
          : /referral/iu.test(token)
            ? "referral"
            : "catalog-message";
    const recognized = lines.slice(1).filter((line) => /^(?:catalog[ -]?id|katalog[ -]?id|product(?: retailer)?[ -]?id|produkt(?:händler)?[ -]?id|products?|produkte?|source(?: id| url| type)?|quelle(?:n[ -]?(?:id|url|typ))?|headline|titel|body|text|thumbnail|vorschaubild|referral[ -]?id|campaign[ -]?id|kampagnen[ -]?id)\s*(?::|-)/iu.test(line));
    const hasIdentifier = recognized.some((line) => /(?:catalog|katalog|product|produkt|referral|campaign|kampagnen)[ -]?id/iu.test(line));
    const minimum = variant === "catalog-message" && hasIdentifier ? 1 : 2;
    if (recognized.length < minimum) return undefined;
    const titles: Record<string, string> = {
      "catalog-message": "Katalognachricht",
      "product-list": "Produktliste",
      "product-inquiry": "Produktanfrage",
      "referred-product": "Empfohlenes Produkt",
      referral: "Empfehlung",
    };
    return {
      type: "business",
      variant,
      title: titles[variant] ?? "Unternehmensnachricht",
      detail: richHeading[2]?.trim(),
      items: lines.slice(1),
    };
  }
  const heading = lines[0]?.match(/^(?:🛍️?\s*)?(product|produkt|order|bestellung|cart|warenkorb|catalog|katalog)\s*(?::|-)\s*(.+)$/iu);
  if (!heading || lines.length < 2) return undefined;
  const details = lines.slice(1);
  const token = heading[1]?.toLocaleLowerCase() ?? "";
  const variant = /order|bestellung/iu.test(token) ? "order" : /cart|warenkorb/iu.test(token) ? "cart" : /catalog|katalog/iu.test(token) ? "catalog" : "product";
  const hasValidPrice = details.some((line) => /^(?:price|preis)\s*(?::|-)\s*(?=.*\d)(?=.*(?:[$€£¥₹₽₩]|AED|AUD|BRL|CAD|CHF|CNY|EUR|GBP|INR|JPY|KRW|MXN|NGN|RUB|SAR|TRY|USD|ZAR)).+$/iu.test(line));
  const hasStrongId = details.some((line) => /^(?:sku|product[ -]?id|produkt[ -]?id|catalog[ -]?id|katalog[ -]?id)\s*(?::|-)\s*(?=\S{3,80}$)(?=.*\d)[a-z0-9._:/-]+$/iu.test(line));
  const hasAvailability = details.some((line) => /^(?:availability|verfügbarkeit)\s*(?::|-)\s*(?:available|in stock|out of stock|unavailable|verfügbar|auf lager|ausverkauft|nicht verfügbar)$/iu.test(line));
  const hasProductField = hasValidPrice || hasStrongId || (hasAvailability && details.length >= 2);
  const hasOrderId = details.some((line) => /^(?:order[ -]?id|bestell(?:nummer|[ -]?id)|cart[ -]?id|warenkorb[ -]?id)\s*(?::|-)/iu.test(line))
    || /^#?[a-z]*\d[a-z0-9_-]{2,}$/iu.test(heading[2]?.trim() ?? "");
  const hasTotal = details.some((line) => /^(?:total|summe|gesamt(?:betrag)?)\s*(?::|-)/iu.test(line));
  const hasItem = details.some((line) => /^(?:item|artikel|product|produkt)\s*(?::|-)/iu.test(line));
  const hasQuantity = details.some((line) => /^(?:quantity|menge|anzahl)\s*(?::|-)/iu.test(line));
  if ((variant === "product" || variant === "catalog") ? !hasProductField : !(hasOrderId || hasTotal || (hasItem && hasQuantity))) return undefined;
  const titles = { product: "Produkt", order: "Bestellung", cart: "Warenkorb", catalog: "Katalog" } as const;
  return {
    type: "business",
    variant,
    title: titles[variant],
    detail: heading[2]?.trim(),
    items: details,
  };
}

function flowSemantic(text: string): MessageSemantic | undefined {
  const lines = markerText(text).split("\n").map((line) => line.trim()).filter(Boolean);
  const replyHeading = lines[0]?.match(/^(?:flow reply|flow response|flow-antwort|flow-antwortnachricht)(?:\s*(?::|-)\s*(.+))?$/iu);
  if (replyHeading) {
    const replyFields = lines.slice(1).filter((line) => /^(?:response|antwort|flow[ -]?(?:id|name|token)|screen|bildschirm|status)\s*(?::|-)/iu.test(line));
    if (replyFields.length < 1) return undefined;
    return {
      type: "interactive",
      variant: "flow-reply",
      title: "Flow-Antwort",
      detail: replyHeading[1]?.trim(),
      items: lines.slice(1),
    };
  }
  const heading = lines[0]?.match(/^(?:whatsapp flow|flow message|flow-nachricht)(?:\s*(?::|-)\s*(.+))?$/iu);
  if (!heading || lines.length < 3) return undefined;
  const fields = lines.slice(1).filter((line) => /^(?:flow[ -]?(?:id|name|token)|screen|bildschirm|button|schaltfläche|action|aktion|status|version)\s*(?::|-)/iu.test(line));
  if (fields.length < 2) return undefined;
  return {
    type: "interactive",
    variant: "flow",
    title: "WhatsApp Flow",
    detail: heading[1]?.trim(),
    items: lines.slice(1),
  };
}

function richInteractiveSemantic(text: string): MessageSemantic | undefined {
  const lines = markerText(text).split("\n").map((line) => line.trim()).filter(Boolean);
  const heading = lines[0]?.match(/^(location request(?: message)?|standortanfrage(?:nachricht)?|address message|adressnachricht|cta url message|call-to-action message|aktionsnachricht|copy code message|code-kopieren-nachricht|carousel message|karussellnachricht)(?:\s*(?::|-)\s*(.+))?$/iu);
  if (!heading || lines.length < 2) return undefined;
  const token = heading[1]?.toLocaleLowerCase() ?? "";
  const variant = /location|standort/iu.test(token) ? "location-request"
    : /address|adress/iu.test(token) ? "address"
      : /cta|call-to-action|aktion/iu.test(token) ? "cta-url"
        : /copy code|code-kopieren/iu.test(token) ? "copy-code" : "carousel";
  const allowedFields: Record<string, RegExp> = {
    "location-request": /^(?:button|schaltfläche|action|aktion)\s*(?::|-)/iu,
    address: /^(?:address(?: field)?|adresse|adressfeld|field|feld|button|schaltfläche|action|aktion)\s*(?::|-)/iu,
    "cta-url": /^(?:url|link|button|schaltfläche|action|aktion)\s*(?::|-)/iu,
    "copy-code": /^(?:code|button|schaltfläche|action|aktion)\s*(?::|-)/iu,
    carousel: /^(?:card(?:\s+\d+)?|karte(?:\s+\d+)?|button|schaltfläche|action|aktion|url|link)\s*(?::|-)/iu,
  };
  if (!lines.slice(1).some((line) => allowedFields[variant]?.test(line))) return undefined;
  const titles: Record<string, string> = {
    "location-request": "Standortanfrage",
    address: "Adressnachricht",
    "cta-url": "Aktionsnachricht",
    "copy-code": "Code kopieren",
    carousel: "Karussellnachricht",
  };
  return {
    type: "interactive",
    variant,
    title: titles[variant] ?? "Interaktive Nachricht",
    detail: heading[2]?.trim(),
    items: lines.slice(1),
  };
}

function interactiveSemantic(text: string): MessageSemantic | undefined {
  const lines = markerText(text).split("\n").map((line) => line.trim()).filter(Boolean);
  const reply = lines[0]?.match(/^(button reply|button-antwort|schaltflächenantwort|list reply|listen-antwort|listenantwort)\s*(?::|-)\s*(.+)$/iu);
  if (reply) {
    const isButton = /button|schaltfläche/iu.test(reply[1] ?? "");
    return {
      type: "interactive",
      variant: isButton ? "reply-button" : "reply-list",
      title: isButton ? "Button-Antwort" : "Listen-Antwort",
      items: [`✓ ${reply[2]?.trim() ?? ""}`, ...lines.slice(1)],
    };
  }
  const heading = lines[0]?.match(/^(?:interactive message|interaktive nachricht|list message|listennachricht|button message|schaltflächen(?:nachricht)?)(?:\s*(?::|-)\s*(.*))?$/iu);
  if (!heading || lines.length < 2) return undefined;
  const items = lines.slice(1)
    .map((line) => {
      const selected = line.match(/^\s*\[(?:x|✓)\]\s*(.+)$/iu);
      if (selected) return `✓ ${selected[1]?.trim() ?? ""}`;
      const unselected = line.match(/^\s*\[\s\]\s*(.+)$/iu);
      if (unselected) return `○ ${unselected[1]?.trim() ?? ""}`;
      return line.replace(/^\s*(?:[-*•○◯]|\d+[.)])\s*/iu, "").trim();
    })
    .filter(Boolean);
  if (!items.length) return undefined;
  return {
    type: "interactive",
    variant: /button|schaltfläche/iu.test(lines[0] ?? "") ? "buttons" : /list|liste/iu.test(lines[0] ?? "") ? "list" : "interactive",
    title: /button|schaltfläche/iu.test(lines[0] ?? "") ? "Auswahlbuttons" : "Auswahlliste",
    detail: heading[1]?.trim() || undefined,
    items,
  };
}

function structuredPlaceholderSemantic(text: string): MessageSemantic | undefined {
  const clean = markerText(text);
  const template = clean.match(/^<\s*(?:template(?:\s+message)?|message template|nachrichtenvorlage|vorlagennachricht)\s+(?:omitted|weggelassen|ausgelassen|nicht enthalten)\s*>[.!]?$/iu);
  if (template) {
    return {
      type: "template",
      variant: "omitted-template",
      title: "Nachrichtenvorlage nicht enthalten",
      detail: "Die strukturierte Nachricht ist im Export nicht verfügbar.",
    };
  }
  const flow = clean.match(/^<\s*(?:whatsapp\s+flow|flow(?:\s+(?:message|reply|response))?|flow-(?:nachricht|antwort))\s+(?:omitted|weggelassen|ausgelassen|nicht enthalten)\s*>[.!]?$/iu);
  if (flow) {
    return {
      type: "interactive",
      variant: /reply|response|antwort/iu.test(clean) ? "omitted-flow-reply" : "omitted-flow",
      title: /reply|response|antwort/iu.test(clean) ? "Flow-Antwort nicht enthalten" : "WhatsApp Flow nicht enthalten",
      detail: "Die strukturierte Nachricht ist im Export nicht verfügbar.",
    };
  }
  const richInteractive = clean.match(/^<\s*(location request(?: message)?|standortanfrage(?:nachricht)?|address message|adressnachricht|cta url message|call-to-action message|aktionsnachricht|copy code message|code-kopieren-nachricht|carousel message|karussellnachricht)\s+(?:omitted|weggelassen|ausgelassen|nicht enthalten)\s*>[.!]?$/iu);
  if (richInteractive) {
    const token = richInteractive[1]?.toLocaleLowerCase() ?? "";
    const variant = /location|standort/iu.test(token) ? "omitted-location-request"
      : /address|adress/iu.test(token) ? "omitted-address"
        : /cta|call-to-action|aktion/iu.test(token) ? "omitted-cta-url"
          : /copy code|code-kopieren/iu.test(token) ? "omitted-copy-code" : "omitted-carousel";
    const titles: Record<string, string> = {
      "omitted-location-request": "Standortanfrage nicht enthalten",
      "omitted-address": "Adressnachricht nicht enthalten",
      "omitted-cta-url": "Aktionsnachricht nicht enthalten",
      "omitted-copy-code": "Code-Nachricht nicht enthalten",
      "omitted-carousel": "Karussellnachricht nicht enthalten",
    };
    return {
      type: "interactive",
      variant,
      title: titles[variant] ?? "Interaktive Nachricht nicht enthalten",
      detail: "Die strukturierte Nachricht ist im Export nicht verfügbar.",
    };
  }
  const richBusiness = clean.match(/^<\s*(catalog message|katalognachricht|product list message|produktlistennachricht|multi-product message|multi-produkt-nachricht|product inquiry(?: message)?|produktanfrage|referred product(?: message)?|empfohlenes produkt|referral message|referral-nachricht)\s+(?:omitted|weggelassen|ausgelassen|nicht enthalten)\s*>[.!]?$/iu);
  if (richBusiness) {
    const token = richBusiness[1]?.toLocaleLowerCase() ?? "";
    const variant = /product list|produktliste|multi-product|multi-produkt/iu.test(token) ? "omitted-product-list"
      : /inquiry|anfrage/iu.test(token) ? "omitted-product-inquiry"
        : /referred product|empfohlenes produkt/iu.test(token) ? "omitted-referred-product"
          : /referral/iu.test(token) ? "omitted-referral" : "omitted-catalog";
    const titles: Record<string, string> = {
      "omitted-product-list": "Produktliste nicht enthalten",
      "omitted-product-inquiry": "Produktanfrage nicht enthalten",
      "omitted-referred-product": "Empfohlenes Produkt nicht enthalten",
      "omitted-referral": "Empfehlung nicht enthalten",
      "omitted-catalog": "Katalog nicht enthalten",
    };
    return {
      type: "business",
      variant,
      title: titles[variant] ?? "Unternehmensnachricht nicht enthalten",
      detail: "Die strukturierte Nachricht ist im Export nicht verfügbar.",
    };
  }
  const match = clean.match(/^<\s*(product|produkt|order|bestellung|cart|warenkorb|catalog|katalog|interactive|interaktiv(?:e nachricht)?|button|schaltfläche|list|liste)(?:\s+message|\s+nachricht)?\s+(?:omitted|weggelassen|ausgelassen|nicht enthalten)\s*>[.!]?$/iu);
  if (!match) {
    const generic = clean.match(/^<\s*([^<>\n]{1,80}?)\s+(?:message|nachricht)\s+(?:omitted|weggelassen|ausgelassen|nicht enthalten)\s*>[.!]?$/iu);
    if (!generic) return undefined;
    return {
      type: "unsupported",
      variant: "omitted-structured-message",
      title: "Strukturierte Nachricht nicht enthalten",
      detail: generic[1]?.trim(),
    };
  }
  const token = match[1]?.toLocaleLowerCase() ?? "";
  const interactive = /interactive|interaktiv|button|schaltfläche|list|liste/iu.test(token);
  if (interactive) {
    const variant = /button|schaltfläche/iu.test(token) ? "omitted-buttons" : /list|liste/iu.test(token) ? "omitted-list" : "omitted-interactive";
    return {
      type: "interactive",
      variant,
      title: variant === "omitted-buttons" ? "Buttons nicht enthalten" : variant === "omitted-list" ? "Liste nicht enthalten" : "Interaktion nicht enthalten",
      detail: "Die strukturierte Nachricht ist im Export nicht verfügbar.",
    };
  }
  const variant = /order|bestellung/iu.test(token) ? "omitted-order" : /cart|warenkorb/iu.test(token) ? "omitted-cart" : /catalog|katalog/iu.test(token) ? "omitted-catalog" : "omitted-product";
  const titles = {
    "omitted-product": "Produkt nicht enthalten",
    "omitted-order": "Bestellung nicht enthalten",
    "omitted-cart": "Warenkorb nicht enthalten",
    "omitted-catalog": "Katalog nicht enthalten",
  } as const;
  return {
    type: "business",
    variant,
    title: titles[variant],
    detail: "Die strukturierte Nachricht ist im Export nicht verfügbar.",
  };
}

function standaloneLinkSemantic(text: string): MessageSemantic | undefined {
  const clean = markerText(text);
  const labeled = clean.match(/^(?:group invite|gruppeneinladung|community invite|community-einladung|call link|anruflink|channel invite|kanaleinladung)\s*(?::|-)\s*(https?:\/\/\S+)$/iu);
  const value = labeled?.[1] ?? clean;
  if (!/^https?:\/\/[^\s]+$/iu.test(value)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return undefined;
  const host = parsed.hostname.replace(/^www\./iu, "");
  const isGroupInvite = host === "chat.whatsapp.com";
  const isCallLink = host === "call.whatsapp.com";
  const isChannelInvite = /(?:^|\.)whatsapp\.com$/iu.test(host) && /^\/channel\//iu.test(parsed.pathname);
  const isContactLink = host === "wa.me";
  if (labeled || isGroupInvite || isCallLink || isChannelInvite || isContactLink) {
    const variant = isCallLink ? "call" : isChannelInvite ? "channel" : isContactLink ? "contact" : /community/iu.test(clean) ? "community" : "group";
    const titles = { call: "WhatsApp-Anruflink", channel: "WhatsApp-Kanal", contact: "WhatsApp-Kontakt", community: "Community-Einladung", group: "Gruppeneinladung" } as const;
    return { type: "invite", variant, title: titles[variant], detail: host, body: value };
  }
  return { type: "link", variant: "url", title: "Link", detail: host, body: value };
}

function systemEventSemantic(text: string, sender: string | null): MessageSemantic | undefined {
  if (sender) return undefined;
  const clean = markerText(text);
  const patterns: Array<{ pattern: RegExp; variant: string; title: string }> = [
    { pattern: /end-to-end encrypted|ende-zu-ende-verschlüsselt/iu, variant: "encryption", title: "Ende-zu-Ende-Verschlüsselung" },
    { pattern: /security code(?: with .+?)? changed|sicherheits(?:nummer|code)(?:\s+.*?)?\s+(?:geändert|hat sich geändert)/iu, variant: "security", title: "Sicherheitsnummer geändert" },
    { pattern: /^(?:this chat is with (?:an? )?(?:official )?business account|you are chatting with (?:an? )?(?:official )?business account|dieser chat findet mit einem (?:offiziellen )?unternehmensaccount statt|du chattest mit einem (?:offiziellen )?unternehmensaccount)(?:[.!]\s*(?:tap|tippe).*)?[.!]?$/iu, variant: "business-notice", title: "Unternehmenshinweis" },
    { pattern: /^(?:this business uses a secure service from meta to manage this chat|dieses unternehmen nutzt einen sicheren service von meta,? um diesen chat zu verwalten)(?:[.!]\s*(?:tap|tippe).*)?[.!]?$/iu, variant: "business-notice", title: "Unternehmenshinweis" },
    { pattern: /^(?:this business account (?:has now registered|is now registered) as a standard account|dieser unternehmensaccount ist jetzt als standardaccount registriert)[.!]?$/iu, variant: "business-account-changed", title: "Unternehmensaccount geändert" },
    { pattern: /created (?:the |this )?group|gruppe(?:\s+.*?)?\s+erstellt/iu, variant: "group-created", title: "Gruppe erstellt" },
    { pattern: /joined using (?:(?:this group's|an?|this) invite link|a group link)|joined (?:this group|the group) (?:with|using) (?:this |an )?invite link|(?:dieser|der) gruppe (?:mit|über) (?:den|diesen|einen) einladungslink beigetreten|über (?:diesen |einen )?einladungslink beigetreten/iu, variant: "participant-joined", title: "Per Einladungslink beigetreten" },
    { pattern: /joined (?:this|the) group|ist (?:dieser|der) gruppe beigetreten/iu, variant: "participant-joined", title: "Gruppe beigetreten" },
    { pattern: /^(?:(?:you|[^\n]{1,120}) changed (?:your|the|[^\n]{1,80}['’]s) member tag(?: from .{1,80})? to .{1,120}|(?:du|[^\n]{1,120}) (?:hast|hat) (?:deinen?|den|[^\n]{1,80}) mitglieds-?tag(?: von .{1,80})? (?:zu|in) .{1,120} geändert)[.!]?$/iu, variant: "member-tag-changed", title: "Mitglieds-Tag geändert" },
    { pattern: /^(?:(?:you|[^\n]{1,120}) removed (?:your|the|[^\n]{1,80}['’]s) member tag|(?:du|[^\n]{1,120}) (?:hast|hat) (?:deinen?|den|[^\n]{1,80}) mitglieds-?tag entfernt)[.!]?$/iu, variant: "member-tag-removed", title: "Mitglieds-Tag entfernt" },
    { pattern: /^(?:(?:you|[^\n]{1,120}) shared (?:the )?group chat history|(?:the )?group chat history (?:was )?shared|(?:du|[^\n]{1,120}) (?:hast|hat) (?:den )?gruppenchatverlauf geteilt|(?:der )?gruppenchatverlauf (?:wurde )?geteilt|(?:der )?gruppenverlauf wurde geteilt|geteilter gruppen(?:chat)?verlauf)[.!]?$/iu, variant: "history-shared", title: "Gruppenverlauf geteilt" },
    { pattern: /(?:added (?:the )?(?:group )?.{1,160} to (?:this|the) community|(?:the )?(?:group )?.{1,160} was added to (?:this|the) community|(?:hat|hast) (?:die gruppe )?.{1,160} (?:zur|zu der) community hinzugefügt|(?:die gruppe )?.{1,160} wurde (?:zur|zu der) community hinzugefügt)/iu, variant: "community-group-added", title: "Gruppe zur Community hinzugefügt" },
    { pattern: /(?:removed (?:the )?(?:group )?.{1,160} from (?:this|the) community|(?:the )?(?:group )?.{1,160} was removed from (?:this|the) community|(?:hat|hast) (?:die gruppe )?.{1,160} aus der community entfernt|(?:die gruppe )?.{1,160} wurde aus der community entfernt)/iu, variant: "community-group-removed", title: "Gruppe aus Community entfernt" },
    { pattern: /\badded\b|hinzugefügt/iu, variant: "participant-added", title: "Teilnehmer hinzugefügt" },
    { pattern: /\bremoved\b|entfernt/iu, variant: "participant-removed", title: "Teilnehmer entfernt" },
    { pattern: /\bleft\b|hat die gruppe verlassen/iu, variant: "participant-left", title: "Gruppe verlassen" },
    { pattern: /changed the (?:group )?(?:subject|name)|(?:gruppen)?(?:betreff|name)(?:\s+.*?)?\s+geändert|hat den betreff (?:zu|von) .+ geändert/iu, variant: "subject-changed", title: "Gruppenname geändert" },
    { pattern: /changed the (?:group )?description|gruppenbeschreibung(?:\s+.*?)?\s+geändert/iu, variant: "description-changed", title: "Gruppenbeschreibung geändert" },
    { pattern: /changed (?:this group's|the group) icon|gruppenbild(?:\s+.*?)?\s+geändert/iu, variant: "icon-changed", title: "Gruppenbild geändert" },
    { pattern: /made .* (?:an? )?admin|(?:you['’]re|you are) (?:now|no longer) an admin|zum admin gemacht|(?:du bist|ist) jetzt (?:ein(?:e|\*e)? )?admin|(?:du bist|ist) kein(?:e|\*e)? admin mehr|nicht mehr admin/iu, variant: "admin-changed", title: "Adminstatus geändert" },
    { pattern: /changed (?:this group's|the group) settings to allow (?:only admins|all participants) to (?:send messages|edit (?:this group's|the group) info|add others)|changed (?:the )?settings so (?:only admins|all members|all participants) can edit (?:the )?group settings|(?:hast|hat) (?:die gruppeneinstellungen|die einstellungen) so geändert,? dass (?:nur admins|alle teilnehmer(?:innen)?|alle mitglieder) (?:nachrichten senden|die gruppeninfo bearbeiten|weitere (?:personen|mitglieder) hinzufügen|die gruppeneinstellungen bearbeiten) (?:können|kann)/iu, variant: "group-permissions", title: "Gruppenberechtigungen geändert" },
    { pattern: /changed (?:this group's|the group) settings|gruppeneinstellungen geändert/iu, variant: "settings-changed", title: "Gruppeneinstellungen geändert" },
    { pattern: /(?:reset|changed|revoked) (?:(?:this group's|the group) invite link|a group link)|einladungslink(?:\s+.*?)?\s+(?:zurückgesetzt|geändert|widerrufen)/iu, variant: "invite-link-changed", title: "Einladungslink geändert" },
    { pattern: /turned on admin approval|admin approval (?:was )?(?:turned on|enabled)|admin-genehmigung(?: .*?)? aktiviert|beitrittsanfragen(?: .*?)? aktiviert/iu, variant: "join-approval-on", title: "Beitrittsfreigabe aktiviert" },
    { pattern: /turned off admin approval|admin approval (?:was )?(?:turned off|disabled)|admin-genehmigung(?: .*?)? deaktiviert|beitrittsanfragen(?: .*?)? deaktiviert/iu, variant: "join-approval-off", title: "Beitrittsfreigabe deaktiviert" },
    { pattern: /^(?:new messages will disappear from this chat .{1,120} after they['’]re sent(?:,? except when kept)?(?:[.!]\s*(?:tap|learn).*)?|messages disappear (?:from this chat )?.{1,160}|neue nachrichten verschwinden .{1,180}(?:aus diesem chat|nachdem sie gesendet wurden).*(?:[.!]\s*tippe.*)?|nachrichten verschwinden (?:aus diesem chat )?.{1,160})[.!]?$/iu, variant: "disappearing-notice", title: "Hinweis zu selbstlöschenden Nachrichten" },
    { pattern: /(?:updated|changed|set) (?:the |your )?(?:default )?message timer|(?:hast|hat) (?:die |deine )?(?:standard-)?nachrichtendauer (?:aktualisiert|geändert|festgelegt)/iu, variant: "disappearing-timer", title: "Nachrichtendauer geändert" },
    { pattern: /turned on disappearing messages|disappearing messages (?:were )?(?:turned on|enabled)|selbstlöschende nachrichten (?:wurden )?aktiviert/iu, variant: "disappearing-on", title: "Selbstlöschende Nachrichten aktiviert" },
    { pattern: /turned off disappearing messages|disappearing messages (?:were )?(?:turned off|disabled)|selbstlöschende nachrichten (?:wurden )?deaktiviert/iu, variant: "disappearing-off", title: "Selbstlöschende Nachrichten deaktiviert" },
    { pattern: /disappearing messages|selbstlöschende nachrichten|standard-nachrichtendauer|nachrichtendauer (?:aktualisiert|geändert)/iu, variant: "disappearing", title: "Selbstlöschende Nachrichten" },
    { pattern: /(?:pinned|unpinned) a message|nachricht (?:angepinnt|losgelöst)/iu, variant: "pinned", title: "Angeheftete Nachricht geändert" },
    { pattern: /advanced chat privacy|erweitert(?:er|en) chat-datenschutz/iu, variant: "privacy", title: "Chat-Datenschutz geändert" },
    { pattern: /changed (?:their )?phone number|telefonnummer .* geändert|hat eine neue telefonnummer/iu, variant: "number-changed", title: "Telefonnummer geändert" },
    { pattern: /^\+?[\d ()-]{6,}\s+changed to\s+\+?[\d ()-]{6,}$/iu, variant: "number-changed", title: "Telefonnummer geändert" },
    { pattern: /^\+?[\d ()-]{6,}\s+hat zu\s+\+?[\d ()-]{6,}\s+gewechselt[.!]?$/iu, variant: "number-changed", title: "Telefonnummer geändert" },
    { pattern: /unblocked (?:this contact|you)|(?:diesen kontakt|dich) (?:entblockiert|freigegeben)/iu, variant: "unblocked", title: "Kontakt freigegeben" },
    { pattern: /\bblocked (?:this contact|you)|(?:diesen kontakt|dich) blockiert/iu, variant: "blocked", title: "Kontakt blockiert" },
    { pattern: /updated (?:an |the )?event|(?:hat|hast) (?:ein |das )?ereignis .* aktualisiert/iu, variant: "event-updated", title: "Ereignis aktualisiert" },
    { pattern: /cancelled (?:an |the )?event|canceled (?:an |the )?event|(?:hat|hast) (?:ein |das )?ereignis .* abgesagt/iu, variant: "event-cancelled", title: "Ereignis abgesagt" },
    { pattern: /^(?:event reminder|ereigniserinnerung)\s*(?::|-)\s*.+$/iu, variant: "event-reminder", title: "Ereigniserinnerung" },
    { pattern: /created (?:an |the )?event|ereignis .* erstellt/iu, variant: "event-created", title: "Ereignis erstellt" },
    { pattern: /created (?:a )?call link|anruflink .* erstellt/iu, variant: "call-link", title: "Anruflink erstellt" },
    { pattern: /(?:started (?:a )?(?:group )?(?:(?:voice|video) )?call|group (?:(?:voice|video) )?call started|hat (?:einen )?(?:gruppen-?)?(?:sprach|video)?anruf gestartet|gruppen(?:sprach|video)?anruf gestartet)/iu, variant: "call-started", title: "Gruppenanruf gestartet" },
    { pattern: /deleted (?:this group's|the group) icon|gruppenbild gelöscht/iu, variant: "icon-deleted", title: "Gruppenbild gelöscht" },
    { pattern: /\bis a contact\b|ist ein kontakt/iu, variant: "contact-status", title: "WhatsApp-Kontakt" },
    { pattern: /meta ai|ai messages (?:are|may be)|ki-nachrichten/iu, variant: "meta-ai", title: "Meta-AI-Hinweis" },
    { pattern: /(?:created (?:a |the )?community|(?:hat|hast) (?:eine |die )?community erstellt)/iu, variant: "community-created", title: "Community erstellt" },
  ];
  const matched = patterns.find(({ pattern }) => pattern.test(clean));
  return matched ? { type: "event", variant: matched.variant, title: matched.title, detail: clean } : undefined;
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function senderPrefixedSystemEventSemantic(text: string, sender: string): MessageSemantic | undefined {
  // Some iOS exports serialize service events as if the group name or actor
  // were a sender. The leading bidi mark is the reliable export signal; the
  // anchored templates prevent ordinary messages such as "Alice left the keys"
  // from being promoted to group events.
  if (!/^\s*[\u200E\u200F]/u.test(text)) return undefined;
  const clean = markerText(text);
  // The syntactic prefix may be the group title rather than the actor named in
  // the service text. Keep the prefix escaped for the common case, but also
  // accept another short actor because the bidi gate and the exact, anchored
  // action phrase still distinguish these records from chat prose.
  const actor = `(?:you|${regexEscape(sender)}|[^\\n]{1,120}?)`;
  const english = new RegExp(
    `^${actor}\\s+(?:created (?:this|the) group|(?:pinned|unpinned) a message|joined (?:this|the) group|joined using (?:(?:this group's|an?|this) invite link|a group link)|left|added .{1,160}|removed .{1,160}|changed (?:the |this )?(?:group )?(?:subject|name|description|icon|settings)(?:\\s+.{1,180})?|(?:changed|reset|revoked) (?:(?:this group's|the group) invite link|a group link)(?:\\s+.{1,180})?|made .{1,120} (?:an? )?admin|created (?:an |the )?event(?:\\s+.{1,180})?|created (?:a )?call link(?:\\s+.{1,180})?|started (?:a )?(?:video )?call|updated the message timer(?:[.!]?\\s+.{1,180})?|turned (?:on|off) (?:admin approval|disappearing messages)(?:[.!]?\\s+.{1,180})?|changed (?:their )?phone number(?:[.!]?\\s+.{1,180})?|(?:blocked|unblocked) (?:this contact|you)|(?:enabled|disabled|turned on|turned off) advanced chat privacy|deleted (?:this group's|the group) icon|is a contact)[.!]?$`,
    "iu",
  );
  const germanActor = `(?:du|${regexEscape(sender)}|[^\\n]{1,120}?)`;
  const german = new RegExp(
    `^${germanActor}\\s+(?:(?:hast|hat) (?:diese |die )?gruppe (?:erstellt|verlassen)|(?:hast|hat) (?:eine |die )?nachricht (?:angepinnt|losgelöst)|(?:bist|ist) (?:dieser|der) gruppe beigetreten|(?:bist|ist) kein(?:e|\\*e)? admin mehr|(?:hast|hat) .{1,160} (?:hinzugefügt|entfernt|zum admin gemacht)|(?:hast|hat) (?:den |diesen )?(?:gruppenname|gruppenbetreff|betreff|gruppenbeschreibung|gruppenbild|gruppen-einladungslink|einladungslink|gruppeneinstellungen) .{0,160}(?:geändert|zurückgesetzt|widerrufen|gelöscht)|(?:hast|hat) (?:ein |das )?ereignis .{0,120}erstellt|(?:hast|hat) (?:einen |den )?anruflink .{0,120}erstellt|(?:hast|hat) einen (?:video-?)?anruf gestartet|(?:hast|hat) die nachrichtendauer (?:aktualisiert|geändert)(?:[.!]?\\s+.{1,180})?|(?:hast|hat) eine neue telefonnummer(?:[.!]?\\s+.{1,180})?|(?:hast|hat) (?:selbstlöschende nachrichten|erweiterten chat-datenschutz) (?:aktiviert|deaktiviert)|(?:hast|hat) (?:diesen kontakt|dich) (?:blockiert|entblockiert|freigegeben))[.!]?$`,
    "iu",
  );
  const security = /^(?:your security code with .+? changed|deine sicherheits(?:nummer|code)(?:\s+.*?)?\s+(?:hat sich geändert|wurde geändert))(?:[.!]\s*.*)?$/iu.test(clean);
  const directEncryption = /^(?:messages and calls are end-to-end encrypted|nachrichten und anrufe sind ende-zu-ende-verschlüsselt)(?:[.!]\s*.*)?$/iu.test(clean);
  const extendedService = new RegExp(
    `^${actor}\\s+(?:added (?:the )?(?:group )?.{1,160} to (?:this|the) community|removed (?:the )?(?:group )?.{1,160} from (?:this|the) community|changed (?:your|the|.{1,80}['’]s) member tag(?:\\s+.{1,180})?|shared (?:the )?group chat history|updated (?:an |the )?event(?:\\s+.{1,180})?|cancelled (?:an |the )?event(?:\\s+.{1,180})?|canceled (?:an |the )?event(?:\\s+.{1,180})?|started (?:a )?group (?:(?:voice|video) )?call)[.!]?$`,
    "iu",
  ).test(clean);
  const extendedGermanService = new RegExp(
    `^${germanActor}\\s+(?:(?:hast|hat) (?:die gruppe )?.{1,160} (?:zur|zu der) community hinzugefügt|(?:hast|hat) (?:die gruppe )?.{1,160} aus der community entfernt|(?:hast|hat) .{1,160} mitglieds-?tag .{1,160}(?:geändert|entfernt)|(?:hast|hat) (?:den )?gruppenchatverlauf geteilt|(?:hast|hat) (?:ein |das )?ereignis .{0,140}(?:aktualisiert|abgesagt)|(?:hast|hat) (?:einen )?(?:gruppen-?)?(?:sprach|video)?anruf gestartet)[.!]?$`,
    "iu",
  ).test(clean);
  const businessNotice = /^(?:this chat is with (?:an? )?(?:official )?business account|you are chatting with (?:an? )?(?:official )?business account|this business uses a secure service from meta to manage this chat|this business account (?:has now registered|is now registered) as a standard account|dieser chat findet mit einem (?:offiziellen )?unternehmensaccount statt|du chattest mit einem (?:offiziellen )?unternehmensaccount|dieses unternehmen nutzt einen sicheren service von meta,? um diesen chat zu verwalten|dieser unternehmensaccount ist jetzt als standardaccount registriert)(?:[.!]\s*(?:tap|tippe).*)?[.!]?$/iu.test(clean);
  const historyNotice = /^(?:(?:the )?group chat history (?:was )?shared|(?:der )?gruppenchatverlauf (?:wurde )?geteilt|(?:der )?gruppenverlauf wurde geteilt|geteilter gruppen(?:chat)?verlauf)[.!]?$/iu.test(clean);
  const disappearingNotice = /^(?:new messages will disappear from this chat .{1,120} after they['’]re sent|messages disappear (?:from this chat )?.{1,160}|neue nachrichten verschwinden .{1,180}|nachrichten verschwinden (?:aus diesem chat )?.{1,160})/iu.test(clean);
  if (!english.test(clean) && !german.test(clean) && !security && !directEncryption && !extendedService && !extendedGermanService && !businessNotice && !historyNotice && !disappearingNotice) return undefined;
  return systemEventSemantic(clean, null);
}

function detectSemantic(text: string, sender: string | null): MessageSemantic | undefined {
  const clean = markerText(text);
  if (VIEW_ONCE_MARKER.test(clean)) {
    return { type: "view-once", title: "Einmalansicht", detail: "Der Inhalt ist im Export nicht verfügbar." };
  }
  if (UNSUPPORTED_MARKER.test(clean)) {
    const waiting = /waiting|warte/iu.test(clean);
    return {
      type: "unsupported",
      variant: waiting ? "waiting" : "version",
      title: waiting ? "Nachricht noch nicht verfügbar" : "Nicht unterstützte Nachricht",
      detail: clean,
    };
  }
  if (EXPIRED_MESSAGE_MARKER.test(clean)) {
    return {
      type: "unsupported",
      variant: "expired",
      title: "Selbstlöschende Nachricht abgelaufen",
      detail: "Der ursprüngliche Inhalt ist im Export nicht mehr verfügbar.",
    };
  }
  return structuredPlaceholderSemantic(clean)
    ?? templateSemantic(clean)
    ?? callSemantic(clean)
    ?? locationSemantic(clean)
    ?? pollSemantic(clean)
    ?? reactionSemantic(clean)
    ?? contactSemantic(clean)
    ?? paymentSemantic(clean)
    ?? structuredEventSemantic(clean)
    ?? businessSemantic(clean)
    ?? flowSemantic(clean)
    ?? richInteractiveSemantic(clean)
    ?? interactiveSemantic(clean)
    ?? standaloneLinkSemantic(clean)
    ?? systemEventSemantic(clean, sender);
}

function isCompleteSenderlessSystemPrefix(text: string, semantic: MessageSemantic | undefined): boolean {
  if (semantic?.type !== "event") return false;
  const clean = markerText(text);
  const direct = /^(?:messages and calls are end-to-end encrypted|nachrichten und anrufe sind ende-zu-ende-verschlüsselt|your security code with .+ changed|deine sicherheits(?:nummer|code).*(?:geändert|hat sich geändert)|\+?[\d ()-]{6,}\s+(?:changed to|hat zu)\s+\+?[\d ()-]{6,})/iu;
  const englishActorAction = /^(?:you|[^\n:]{1,120})\s+(?:created\b|joined\b|left\b|added\s+\S|removed\s+\S|changed\s+\S|made\s+\S|turned\s+(?:on|off)\b|updated\s+\S|cancelled\s+\S|canceled\s+\S|started\s+\S|pinned\b|unpinned\b|blocked\b|unblocked\b|enabled\b|disabled\b|deleted\s+\S|is a contact\b)/iu;
  const germanActorAction = /^(?:du|[^\n:]{1,120})\s+(?:(?:hast|hat)\s+\S|(?:bist|ist)\s+\S)/iu;
  return direct.test(clean) || englishActorAction.test(clean) || germanActorAction.test(clean);
}

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

function senderCandidates(rest: string): Array<{ sender: string; text: string }> {
  const candidates: Array<{ sender: string; text: string }> = [];
  const delimiter = /:(?:\s|$)/gu;
  let match: RegExpExecArray | null;
  while ((match = delimiter.exec(rest))) {
    const sender = markerText(rest.slice(0, match.index));
    if (
      sender.length > 0
      && sender.length <= 120
      && !/[<>\n]/u.test(sender)
      && !/^(?:https?|ftp)$/iu.test(sender)
    ) {
      candidates.push({ sender, text: rest.slice(match.index + match[0].length) });
    }
    if (match[0].length === 0) delimiter.lastIndex += 1;
  }
  return candidates;
}

function senderPrefixCounts(records: RawRecord[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const record of records) {
    for (const candidate of senderCandidates(record.rest)) {
      counts.set(candidate.sender, (counts.get(candidate.sender) ?? 0) + 1);
    }
  }
  return counts;
}

function splitSender(rest: string, prefixCounts: ReadonlyMap<string, number>): { sender: string | null; text: string } {
  const candidates = senderCandidates(rest);
  if (!candidates.length) return { sender: null, text: rest };
  const repeated = candidates.filter(({ sender }) => (prefixCounts.get(sender) ?? 0) >= 2);
  const selected = repeated.length ? repeated[repeated.length - 1] : candidates[0];
  if (!selected) return { sender: null, text: rest };
  const sender = selected.sender;
  if (!sender || /^(?:https?|ftp)$/iu.test(sender)) return { sender: null, text: rest };
  return selected;
}

function classifyMessage(
  text: string,
  sender: string | null,
): Pick<ChatMessage, "kind" | "displayText" | "mediaHint" | "mediaReference" | "mediaRole" | "semantic"> {
  const clean = markerText(text);
  if (!clean) {
    return {
      kind: "unknown",
      semantic: {
        type: "unsupported",
        variant: "not-exported",
        title: "Nicht exportierter WhatsApp-Inhalt",
        detail: "Dieser Eintrag enthält im Chat-Export keinen darstellbaren Inhalt.",
      },
    };
  }
  const filename = extractExplicitAttachmentReferences(text)[0]?.filename
    ?? (text.match(ATTACHED_PATTERN) ?? text.match(FILE_ATTACHED_PATTERN))?.[1];
  if (filename) {
    const mediaHint = mediaKindFromFilename(filename);
    return {
      kind: "media",
      mediaHint,
      mediaReference: filename.trim(),
      mediaRole: mediaPresentationRole(filename, "", mediaHint),
    };
  }
  const contentLines = clean.split("\n");
  let viewOnceMarker: string | undefined;
  let viewOnceCaption: string | undefined;
  if (VIEW_ONCE_MARKER.test(clean)) {
    viewOnceMarker = clean;
  } else if (contentLines.length > 1 && VIEW_ONCE_MARKER.test(contentLines[0]?.trim() ?? "")) {
    viewOnceMarker = contentLines[0]?.trim();
    viewOnceCaption = contentLines.slice(1).join("\n").trim() || undefined;
  } else if (contentLines.length > 1 && VIEW_ONCE_MARKER.test(contentLines.at(-1)?.trim() ?? "")) {
    viewOnceMarker = contentLines.at(-1)?.trim();
    viewOnceCaption = contentLines.slice(0, -1).join("\n").trim() || undefined;
  } else {
    const inlineSuffix = text.match(/^([\s\S]*?\S)\s*[\u200E\u200F]+([^\n]+)$/u);
    const inlineMarker = markerText(inlineSuffix?.[2] ?? "");
    if (inlineSuffix?.[1] && VIEW_ONCE_MARKER.test(inlineMarker)) {
      viewOnceMarker = inlineMarker;
      viewOnceCaption = inlineSuffix[1].trim() || undefined;
    }
  }
  if (viewOnceMarker) {
    const mediaHint: MediaKind | undefined = /(?:voice message|sprachnachricht|audio)/iu.test(viewOnceMarker)
      ? "audio"
      : /video/iu.test(viewOnceMarker)
        ? "video"
        : /(?:photo|image|foto|bild)/iu.test(viewOnceMarker)
          ? "image"
          : undefined;
    return {
      kind: "media-omitted",
      mediaHint,
      mediaRole: mediaPresentationRole("", viewOnceMarker, mediaHint),
      semantic: {
        type: "view-once",
        title: "Einmalansicht",
        detail: "Der Inhalt ist im Export nicht verfügbar.",
        body: viewOnceCaption,
      },
    };
  }
  const semantic = detectSemantic(clean, sender);
  for (const [pattern, hint] of OMITTED_MARKERS) {
    if (pattern.test(clean)) return {
      kind: "media-omitted",
      mediaHint: hint,
      mediaRole: mediaPresentationRole("", pattern.test(contentLines[0]?.trim() ?? "") ? contentLines[0]?.trim() ?? "" : clean, hint),
    };
    const lines = clean.split("\n");
    const finalLine = lines.at(-1)?.trim() ?? "";
    if (lines.length > 1 && pattern.test(finalLine)) return {
      kind: "media-omitted",
      displayText: `${finalLine}\n${lines.slice(0, -1).join("\n").trim()}`,
      mediaHint: hint,
      mediaRole: mediaPresentationRole("", finalLine, hint),
    };
    const inlineSuffix = text.match(/^([\s\S]*?\S)\s*[\u200E\u200F]+([^\n]+)$/u);
    const inlineMarker = markerText(inlineSuffix?.[2] ?? "");
    if (inlineSuffix?.[1] && pattern.test(inlineMarker)) return {
      kind: "media-omitted",
      displayText: `${inlineMarker}\n${inlineSuffix[1].trim()}`,
      mediaHint: hint,
      mediaRole: mediaPresentationRole("", inlineMarker, hint),
    };
  }
  if (DELETED_MARKER.test(clean)) return { kind: "deleted" };
  return { kind: sender ? "text" : "system", semantic };
}

export function mediaKindFromFilename(filename: string): MediaKind {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (["jpg", "jpeg", "png", "gif", "avif", "bmp", "tif", "tiff", "heic", "heif"].includes(ext)) return "image";
  if (ext === "webp") return /(?:^|[\/\s_.-])(?:stk|sticker)(?:[\s_.-]|$)/iu.test(filename) ? "sticker" : "image";
  if (["mp4", "mov", "m4v", "webm", "mkv", "3gp", "3gpp", "avi", "mpeg", "mpg", "ogv", "mts", "m2ts", "wmv", "flv"].includes(ext)) return "video";
  if (["opus", "ogg", "oga", "m4a", "mp3", "aac", "wav", "amr", "flac", "caf", "3ga", "weba", "wma", "aif", "aiff"].includes(ext)) return "audio";
  return "document";
}

export function mediaPresentationRole(
  filename: string,
  marker = "",
  mediaKind?: MediaKind,
): MediaPresentationRole | undefined {
  const resolvedKind = mediaKind ?? (filename ? mediaKindFromFilename(filename) : undefined);
  const value = `${filename} ${marker}`.toLocaleLowerCase();
  if (/\.(?:vcf|vcard)\b|contact card|kontaktkarte/iu.test(value)) return "contact";
  if (resolvedKind === "sticker" || /(?:^|[\s_.-])(?:stk|sticker)(?:[\s_.-]|$)/iu.test(value)) return "sticker";
  if (/\.gif\b|(?:^|[\s_.-])gif(?:[\s_.-]|$)|animated image|animiertes bild/iu.test(value)) return "animated-image";
  if (resolvedKind === "image") {
    return "photo";
  }
  if (resolvedKind === "video") {
    return /(?:^|[\s_.-])ptv(?:[\s_.-]|$)|video[ -]?note|videonotiz|videonachricht/iu.test(value) ? "video-note" : "video";
  }
  if (resolvedKind === "audio") {
    return /(?:^|[\s_.-])ptt(?:[\s_.-]|$)|voice message|voice note|sprachnachricht/iu.test(value)
      ? "voice-note"
      : "audio";
  }
  return resolvedKind === "document" ? "document" : undefined;
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
  const prefixCounts = senderPrefixCounts(records);
  const messages: ChatMessage[] = [];
  let invalidTimestampLines = 0;
  let reversedTimestamps = 0;

  for (const record of records) {
    const timestamp = parseTimestamp(record, detected.order);
    if (!timestamp) {
      invalidTimestampLines += 1;
      continue;
    }
    // Some sender-less WhatsApp system events contain a colon in their detail.
    // Only override sender splitting when a known system marker already occurs
    // before that first delimiter; "Ralph: I left the keys" must stay a normal
    // message from Ralph.
    const senderlessSemantic = detectSemantic(record.rest, null);
    const delimiter = record.rest.search(/:(?:\s|$)/u);
    const semanticBeforeDelimiter = delimiter >= 0
      ? systemEventSemantic(record.rest.slice(0, delimiter), null)
      : undefined;
    const safeSenderlessEvent = senderlessSemantic?.type === "event"
      && semanticBeforeDelimiter?.variant === senderlessSemantic.variant
      && isCompleteSenderlessSystemPrefix(record.rest.slice(0, delimiter), semanticBeforeDelimiter);
    const split = safeSenderlessEvent
      ? { sender: null, text: record.rest }
      : splitSender(record.rest, prefixCounts);
    const { sender, text: firstLine } = split;
    const body = [firstLine, ...record.continuation].join("\n").replace(/\n+$/u, "");
    const decorations = extractDecorations(body);
    const prefixedSystemSemantic = sender ? senderPrefixedSystemEventSemantic(decorations.content, sender) : undefined;
    const effectiveSender = prefixedSystemSemantic ? null : sender;
    const explicitAttachments = prefixedSystemSemantic ? [] : extractExplicitAttachmentReferences(decorations.content);
    const classifications = explicitAttachments.length > 1
      ? explicitAttachments.map(({ filename }) => {
        const mediaHint = mediaKindFromFilename(filename);
        return {
          kind: "media" as const,
          mediaHint,
          mediaReference: filename,
          mediaRole: mediaPresentationRole(filename, "", mediaHint),
        };
      })
      : [prefixedSystemSemantic
        ? { kind: "system" as const, semantic: prefixedSystemSemantic }
        : classifyMessage(decorations.content, effectiveSender)];
    const previous = messages[messages.length - 1];
    const warnings: string[] = [];
    if (previous && timestamp.getTime() < previous.timestamp.getTime()) {
      reversedTimestamps += 1;
      warnings.push("Zeitstempel liegt vor der vorherigen Nachricht; Quelldateireihenfolge bleibt erhalten.");
    }
    const logicalMessageId = `msg-${record.sourceOrder}`;
    const multiCaption = classifications.length > 1 ? stripExplicitAttachmentMarkers(decorations.content) : undefined;
    classifications.forEach((classification, index) => {
      const firstInGroup = index === 0;
      const lastInGroup = index === classifications.length - 1;
      messages.push({
        id: classifications.length > 1 ? `${logicalMessageId}-${index}` : logicalMessageId,
        sourceOrder: record.sourceOrder,
        timestamp,
        rawTimestamp: record.rawTimestamp,
        precision: record.precision,
        sender: effectiveSender,
        text: body,
        displayText: classifications.length > 1
          ? firstInGroup ? multiCaption ?? "" : ""
          : decorations.content !== body ? decorations.content : undefined,
        forwarded: firstInGroup ? decorations.forwarded : undefined,
        frequentlyForwarded: firstInGroup ? decorations.frequentlyForwarded : undefined,
        edited: lastInGroup ? decorations.edited : undefined,
        quotedText: firstInGroup ? decorations.quotedText : undefined,
        ...(classifications.length > 1 ? {
          logicalMessageId,
          attachmentGroup: { id: logicalMessageId, index, size: classifications.length, kind: "explicit-multi" as const },
        } : {}),
        ...classification,
        warnings: firstInGroup ? warnings : [],
      });
    });
  }

  const participants = [...new Set(messages.map((message) => message.sender).filter((sender): sender is string => Boolean(sender)))];
  const warnings: string[] = [];
  if (detected.ambiguous) warnings.push("Das Datumsformat ist nicht eindeutig. Bitte die Vorschau prüfen.");
  if (reversedTimestamps) warnings.push(`${reversedTimestamps} rückwärts laufende Zeitstempel erkannt; die Exportreihenfolge wurde beibehalten.`);
  const diagnostics: ParseDiagnostics = {
    totalLines: lines.length,
    parsedMessages: records.length - invalidTimestampLines,
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
