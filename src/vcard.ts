export interface ContactCardInfo {
  name: string;
  organization?: string;
  phones: string[];
  emails: string[];
  addresses?: string[];
  urls?: string[];
  birthday?: string;
  note?: string;
  additionalContacts?: number;
  additionalContactNames?: string[];
}

const MAX_TEXT_CHARACTERS = 1024 * 1024;
const MAX_PHYSICAL_LINES = 4096;
const MAX_LOGICAL_LINE_CHARACTERS = 128 * 1024;
const MAX_FIELDS = 1024;
const MAX_RELEVANT_VALUE_CHARACTERS = 16 * 1024;
const MAX_CONTACT_VALUES = 64;

function unfoldLines(text: string): string[] | undefined {
  const physicalLines = text
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .split("\n");
  if (physicalLines.length > MAX_PHYSICAL_LINES) return undefined;

  const logicalLines: string[] = [];
  for (const physicalLine of physicalLines) {
    const previousIndex = logicalLines.length - 1;
    const previous = logicalLines[previousIndex] ?? "";
    if (/ENCODING\s*=\s*QUOTED-PRINTABLE/iu.test(previous) && previous.endsWith("=")) {
      const combined = `${previous.slice(0, -1)}${physicalLine.replace(/^[ \t]/u, "")}`;
      if (combined.length > MAX_LOGICAL_LINE_CHARACTERS) return undefined;
      logicalLines[previousIndex] = combined;
    } else if (/^[ \t]/u.test(physicalLine) && logicalLines.length > 0) {
      const combined = `${logicalLines[previousIndex] ?? ""}${physicalLine.slice(1)}`;
      if (combined.length > MAX_LOGICAL_LINE_CHARACTERS) return undefined;
      logicalLines[previousIndex] = combined;
    } else {
      if (physicalLine.length > MAX_LOGICAL_LINE_CHARACTERS) return undefined;
      logicalLines.push(physicalLine);
    }
  }
  return logicalLines;
}

function vCardBody(lines: string[]): string[] {
  const begin = lines.findIndex((line) => /^BEGIN:VCARD\s*$/iu.test(line.trim()));
  if (begin < 0) return lines;
  const relativeEnd = lines.slice(begin + 1).findIndex((line) => /^END:VCARD\s*$/iu.test(line.trim()));
  const end = relativeEnd < 0 ? lines.length : begin + 1 + relativeEnd;
  return lines.slice(begin + 1, end);
}

function vCardBodies(lines: string[]): string[][] {
  const bodies: string[][] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    if (/^BEGIN:VCARD\s*$/iu.test(line.trim())) {
      if (current) bodies.push(current);
      current = [];
    } else if (/^END:VCARD\s*$/iu.test(line.trim())) {
      if (current) bodies.push(current);
      current = undefined;
    } else if (current) {
      current.push(line);
    }
  }
  if (current) bodies.push(current);
  return bodies.length ? bodies : [vCardBody(lines)];
}

function valueSeparator(line: string): number {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "\"") {
      quoted = !quoted;
      continue;
    }
    if (character === ":" && !quoted) return index;
  }
  return -1;
}

function propertyName(descriptor: string): string {
  const nameWithGroup = descriptor.split(";", 1)[0]?.trim() ?? "";
  return (nameWithGroup.split(".").pop() ?? "").toLocaleUpperCase();
}

function parameterValue(descriptor: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = descriptor.match(new RegExp(`(?:^|;)${escaped}=(?:"([^"]*)"|([^;:]*))`, "iu"));
  return (match?.[1] ?? match?.[2])?.trim();
}

function decodeBytes(bytes: Uint8Array, charset?: string): string | undefined {
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    try {
      return new TextDecoder("utf-8").decode(bytes);
    } catch {
      return undefined;
    }
  }
}

function decodeEncodedValue(descriptor: string, value: string): string {
  const encoding = parameterValue(descriptor, "ENCODING")?.toLocaleUpperCase();
  const charset = parameterValue(descriptor, "CHARSET");
  if (encoding === "QUOTED-PRINTABLE") {
    const bytes: number[] = [];
    for (let index = 0; index < value.length;) {
      const encoded = value.slice(index).match(/^=([0-9A-F]{2})/iu);
      if (encoded?.[1]) {
        bytes.push(Number.parseInt(encoded[1], 16));
        index += 3;
        continue;
      }
      const character = String.fromCodePoint(value.codePointAt(index) ?? 0);
      bytes.push(...new TextEncoder().encode(character));
      index += character.length;
    }
    return decodeBytes(new Uint8Array(bytes), charset) ?? value;
  }
  if (encoding === "B" || encoding === "BASE64") {
    try {
      const binary = atob(value.replace(/\s+/gu, ""));
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return decodeBytes(bytes, charset) ?? value;
    } catch {
      return value;
    }
  }
  return value;
}

function splitEscaped(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (character === "\\" && index + 1 < value.length) {
      current += character + (value[index + 1] ?? "");
      index += 1;
    } else if (character === separator) {
      parts.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  parts.push(current);
  return parts;
}

function unescapeValue(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (character !== "\\") {
      result += character;
      continue;
    }

    const escaped = value[index + 1];
    if (escaped === undefined) {
      result += "\\";
      continue;
    }
    index += 1;
    if (escaped === "n" || escaped === "N") result += "\n";
    else if (escaped === "\\" || escaped === "," || escaped === ";") result += escaped;
    else result += `\\${escaped}`;
  }
  return result.trim().normalize("NFC");
}

function structuredName(value: string): string | undefined {
  const components = splitEscaped(value, ";").map(unescapeValue);
  const family = components[0] ?? "";
  const given = components[1] ?? "";
  const additional = components[2] ?? "";
  const prefix = components[3] ?? "";
  const suffix = components[4] ?? "";
  const name = [prefix, given, additional, family, suffix].filter(Boolean).join(" ").trim();
  return name || undefined;
}

function organizationName(value: string): string | undefined {
  const organization = splitEscaped(value, ";")
    .map(unescapeValue)
    .filter(Boolean)
    .join(" · ")
    .trim();
  return organization || undefined;
}

function contactValue(value: string, scheme: "tel" | "mailto"): string | undefined {
  const decoded = unescapeValue(value)
    .replace(new RegExp(`^${scheme}:`, "iu"), "")
    .replace(/\s*\n\s*/gu, "")
    .trim();
  return decoded || undefined;
}

function addressValue(value: string): string | undefined {
  const address = splitEscaped(value, ";")
    .map(unescapeValue)
    .filter(Boolean)
    .join(", ")
    .replace(/\s+/gu, " ")
    .trim();
  return address || undefined;
}

function urlValue(value: string): string | undefined {
  const url = unescapeValue(value).replace(/\s*\n\s*/gu, "").trim();
  return /^(?:https?|ftp):\/\/\S+$/iu.test(url) ? url : undefined;
}

function bodyHasDisplayIdentity(body: string[]): boolean {
  for (const line of body) {
    const separator = valueSeparator(line);
    if (separator <= 0) continue;
    const descriptor = line.slice(0, separator);
    const property = propertyName(descriptor);
    if (!["FN", "N", "ORG", "TEL", "EMAIL"].includes(property)) continue;
    const value = decodeEncodedValue(descriptor, line.slice(separator + 1));
    if (property === "FN" && unescapeValue(value)) return true;
    if (property === "N" && structuredName(value)) return true;
    if (property === "ORG" && organizationName(value)) return true;
    if (property === "TEL" && contactValue(value, "tel")) return true;
    if (property === "EMAIL" && contactValue(value, "mailto")) return true;
  }
  return false;
}

function pushUnique(values: string[], value: string, caseInsensitive = false): boolean {
  const comparison = caseInsensitive ? value.toLocaleLowerCase() : value;
  if (values.some((current) => (caseInsensitive ? current.toLocaleLowerCase() : current) === comparison)) return true;
  if (values.length >= MAX_CONTACT_VALUES) return false;
  values.push(value);
  return true;
}

export function parseVCard(text: string): ContactCardInfo | undefined {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_TEXT_CHARACTERS || text.includes("\0")) return undefined;
  const unfolded = unfoldLines(text);
  if (!unfolded) return undefined;
  const bodies = vCardBodies(unfolded).filter(bodyHasDisplayIdentity);
  if (!bodies.length) return undefined;
  const cardCount = bodies.length;

  let formattedName: string | undefined;
  let componentName: string | undefined;
  let organization: string | undefined;
  const phones: string[] = [];
  const emails: string[] = [];
  const addresses: string[] = [];
  const urls: string[] = [];
  let birthday: string | undefined;
  let note: string | undefined;
  let fieldCount = 0;

  for (const line of bodies[0] ?? []) {
    if (!line.trim()) continue;
    const separator = valueSeparator(line);
    if (separator <= 0) continue;
    fieldCount += 1;
    if (fieldCount > MAX_FIELDS) return undefined;

    const descriptor = line.slice(0, separator);
    const property = propertyName(descriptor);
    if (!["FN", "N", "ORG", "TEL", "EMAIL", "ADR", "URL", "BDAY", "NOTE"].includes(property)) continue;
    const rawValue = decodeEncodedValue(descriptor, line.slice(separator + 1));
    if (rawValue.length > MAX_RELEVANT_VALUE_CHARACTERS) return undefined;

    if (property === "FN" && !formattedName) {
      formattedName = unescapeValue(rawValue) || undefined;
    } else if (property === "N" && !componentName) {
      componentName = structuredName(rawValue);
    } else if (property === "ORG" && !organization) {
      organization = organizationName(rawValue);
    } else if (property === "TEL") {
      const phone = contactValue(rawValue, "tel");
      if (phone && !pushUnique(phones, phone)) return undefined;
    } else if (property === "EMAIL") {
      const email = contactValue(rawValue, "mailto");
      if (email && !pushUnique(emails, email, true)) return undefined;
    } else if (property === "ADR") {
      const address = addressValue(rawValue);
      if (address && !pushUnique(addresses, address, true)) return undefined;
    } else if (property === "URL") {
      const url = urlValue(rawValue);
      if (url && !pushUnique(urls, url, true)) return undefined;
    } else if (property === "BDAY" && !birthday) {
      birthday = unescapeValue(rawValue).replace(/\s+/gu, " ").trim() || undefined;
    } else if (property === "NOTE" && !note) {
      note = unescapeValue(rawValue).trim() || undefined;
    }
  }

  const name = formattedName ?? componentName ?? organization ?? phones[0] ?? emails[0];
  if (!name) return undefined;
  const additionalContactNames = bodies.slice(1).flatMap((body) => {
    let formatted: string | undefined;
    let structured: string | undefined;
    let company: string | undefined;
    for (const line of body) {
      const separator = valueSeparator(line);
      if (separator <= 0) continue;
      const descriptor = line.slice(0, separator);
      const property = propertyName(descriptor);
      const value = decodeEncodedValue(descriptor, line.slice(separator + 1));
      if (property === "FN" && !formatted) formatted = unescapeValue(value) || undefined;
      else if (property === "N" && !structured) structured = structuredName(value);
      else if (property === "ORG" && !company) company = organizationName(value);
    }
    const displayName = formatted ?? structured ?? company;
    return displayName ? [displayName] : [];
  }).slice(0, MAX_CONTACT_VALUES);
  return {
    name,
    ...(organization ? { organization } : {}),
    phones,
    emails,
    ...(addresses.length ? { addresses } : {}),
    ...(urls.length ? { urls } : {}),
    ...(birthday ? { birthday } : {}),
    ...(note ? { note } : {}),
    ...(cardCount > 1 ? { additionalContacts: cardCount - 1 } : {}),
    ...(additionalContactNames.length ? { additionalContactNames } : {}),
  };
}
