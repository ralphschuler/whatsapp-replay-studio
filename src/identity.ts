import type { ChatMessage } from "./types";

export const SELF_NOT_IN_EXPORT = "__whatsapp_replay_self_not_in_export__";

export type MessageDirection = "incoming" | "outgoing" | "system" | "unknown";

export interface SelfIdentityResolution {
  selfName?: string;
  counterpartName?: string;
  source: "preferred" | "filename" | "unresolved";
}

const INVISIBLE_CONTROLS = /[\uFEFF\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069]/gu;
const GROUP_EVENT_VARIANTS = new Set([
  "admin-changed",
  "community-group-added",
  "community-group-removed",
  "description-changed",
  "group-created",
  "group-permissions",
  "history-shared",
  "icon-changed",
  "icon-deleted",
  "invite-link-changed",
  "join-approval-off",
  "join-approval-on",
  "member-tag-changed",
  "member-tag-removed",
  "participant-added",
  "participant-joined",
  "participant-left",
  "participant-removed",
  "settings-changed",
  "subject-changed",
]);

function cleanIdentity(value: string): string {
  return value
    .replace(INVISIBLE_CONTROLS, "")
    .replace(/\s+/gu, " ")
    .trim()
    .normalize("NFC");
}

function identityKey(value: string): string {
  const clean = cleanIdentity(value).toLocaleLowerCase();
  if (/^\+?[\d ()-]{6,}$/u.test(clean)) {
    const sign = clean.startsWith("+") ? "+" : "";
    return `phone:${sign}${clean.replace(/\D/gu, "")}`;
  }
  return `name:${clean}`;
}

export function sameParticipant(first: string, second: string): boolean {
  return identityKey(first) === identityKey(second);
}

function filenameStem(filename: string): string {
  const basename = filename.replace(/\\/gu, "/").split("/").filter(Boolean).pop() ?? filename;
  return cleanIdentity(basename.replace(/\.(?:zip|txt)$/iu, ""));
}

export function chatCounterpartFromFilename(filename: string): string | undefined {
  const stem = filenameStem(filename);
  const relation = stem.match(/^(?:whatsapp[\s_-]*chat|_?chat|_?conversation)[\s_-]+(?:with|mit)[\s_-]+(.+)$/iu);
  const separated = stem.match(/^(?:whatsapp[\s_-]*chat|_?chat|_?conversation)\s*[-–—:]\s*(.+)$/iu);
  const candidate = cleanIdentity(relation?.[1] ?? separated?.[1] ?? "");
  return candidate || undefined;
}

export function chatTitleFromFilename(filename: string): string {
  const counterpart = chatCounterpartFromFilename(filename);
  if (counterpart) return counterpart;
  const stem = filenameStem(filename);
  const withoutPrefix = stem.replace(
    /^(?:whatsapp[\s_-]*chat|_?chat|_?conversation)(?=$|[\s_-]|[-–—:])(?:[\s_-]+(?:with|mit))?(?:\s*[-–—:]\s*|[\s_-]+)?/iu,
    "",
  );
  return cleanIdentity(withoutPrefix.replace(/_+/gu, " ")) || "WhatsApp Replay";
}

export function hasExplicitGroupEvidence(messages: readonly ChatMessage[]): boolean {
  return messages.some((message) => message.semantic?.type === "event"
    && Boolean(message.semantic.variant && GROUP_EVENT_VARIANTS.has(message.semantic.variant)));
}

export function resolveSelfIdentity(options: {
  participants: readonly string[];
  filename: string;
  chatFilename: string;
  messages: readonly ChatMessage[];
  preferredSelfName?: string;
}): SelfIdentityResolution {
  const { participants, filename, chatFilename, messages, preferredSelfName } = options;
  if (preferredSelfName === SELF_NOT_IN_EXPORT) {
    return { selfName: SELF_NOT_IN_EXPORT, source: "preferred" };
  }
  if (preferredSelfName) {
    const preserved = participants.find((participant) => sameParticipant(participant, preferredSelfName));
    if (preserved) return { selfName: preserved, source: "preferred" };
  }

  const participantKeys = participants.map(identityKey);
  if (participants.length !== 2 || new Set(participantKeys).size !== 2 || hasExplicitGroupEvidence(messages)) {
    return { source: "unresolved" };
  }

  const counterpartCandidates = [filename, chatFilename]
    .map(chatCounterpartFromFilename)
    .filter((candidate): candidate is string => Boolean(candidate));
  const candidateKeys = [...new Set(counterpartCandidates.map(identityKey))];
  if (candidateKeys.length !== 1) return { source: "unresolved" };

  const counterpartIndex = participantKeys.findIndex((key) => key === candidateKeys[0]);
  if (counterpartIndex < 0) return { source: "unresolved" };
  const selfIndex = counterpartIndex === 0 ? 1 : 0;
  const selfName = participants[selfIndex];
  const counterpartName = participants[counterpartIndex];
  return selfName && counterpartName
    ? { selfName, counterpartName, source: "filename" }
    : { source: "unresolved" };
}

export function messageDirection(message: ChatMessage, selfName: string): MessageDirection {
  if (!message.sender) return "system";
  if (!selfName) return "unknown";
  if (selfName === SELF_NOT_IN_EXPORT) return "incoming";
  return sameParticipant(message.sender, selfName) ? "outgoing" : "incoming";
}
