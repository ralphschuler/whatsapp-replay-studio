import { describe, expect, it } from "vitest";
import {
  chatCounterpartFromFilename,
  chatTitleFromFilename,
  messageDirection,
  resolveSelfIdentity,
  SELF_NOT_IN_EXPORT,
} from "../src/identity";
import type { ChatMessage } from "../src/types";

function message(sender: string | null, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `message-${sender ?? "system"}`,
    sourceOrder: 0,
    timestamp: new Date(2026, 6, 20, 10, 0),
    rawTimestamp: "20.07.26, 10:00",
    precision: "minute",
    sender,
    text: "Hallo",
    kind: sender ? "text" : "system",
    warnings: [],
    ...overrides,
  };
}

describe("chat identity", () => {
  it("extracts trusted WhatsApp counterpart names and readable titles", () => {
    expect(chatCounterpartFromFilename("WhatsApp Chat - Knöbelblöck.zip")).toBe("Knöbelblöck");
    expect(chatCounterpartFromFilename("WhatsApp-Chat mit Änne.txt")).toBe("Änne");
    expect(chatCounterpartFromFilename("_chat with Alice.txt")).toBe("Alice");
    expect(chatCounterpartFromFilename("Urlaub.zip")).toBeUndefined();
    expect(chatTitleFromFilename("WhatsApp Chat - Knöbelblöck.zip")).toBe("Knöbelblöck");
  });

  it("infers the other participant in a clear direct-chat export", () => {
    const result = resolveSelfIdentity({
      participants: ["Knöbelblöck", "Ralph"],
      filename: "WhatsApp Chat - Kno\u0308belblo\u0308ck.zip",
      chatFilename: "_chat.txt",
      messages: [message("Knöbelblöck"), message("Ralph")],
    });
    expect(result).toEqual({
      selfName: "Ralph",
      counterpartName: "Knöbelblöck",
      source: "filename",
    });
  });

  it("does not depend on first-message or participant order", () => {
    const result = resolveSelfIdentity({
      participants: ["Ralph", "Alice"],
      filename: "WhatsApp Chat with Alice.zip",
      chatFilename: "_chat.txt",
      messages: [message("Alice"), message("Ralph")],
    });
    expect(result.selfName).toBe("Ralph");
  });

  it("preserves an explicit selection before considering the filename", () => {
    const result = resolveSelfIdentity({
      participants: ["Mia", "Ralph"],
      filename: "WhatsApp Chat - Mia.zip",
      chatFilename: "_chat.txt",
      messages: [message("Mia"), message("Ralph")],
      preferredSelfName: "Mia",
    });
    expect(result).toEqual({ selfName: "Mia", source: "preferred" });
  });

  it("keeps an explicit all-incoming selection", () => {
    const result = resolveSelfIdentity({
      participants: ["Mia"],
      filename: "_chat.txt",
      chatFilename: "_chat.txt",
      messages: [message("Mia")],
      preferredSelfName: SELF_NOT_IN_EXPORT,
    });
    expect(result).toEqual({ selfName: SELF_NOT_IN_EXPORT, source: "preferred" });
  });

  it.each([
    {
      name: "group with more than two senders",
      participants: ["Alice", "Ralph", "Mia"],
      filename: "WhatsApp Chat - Alice.zip",
      chatFilename: "_chat.txt",
      messages: [message("Alice"), message("Ralph"), message("Mia")],
    },
    {
      name: "two active senders with explicit group evidence",
      participants: ["Alice", "Ralph"],
      filename: "WhatsApp Chat - Alice.zip",
      chatFilename: "_chat.txt",
      messages: [
        message("Alice"),
        message(null, { semantic: { type: "event", variant: "group-created", title: "Gruppe erstellt" } }),
      ],
    },
    {
      name: "only one observed sender",
      participants: ["Alice"],
      filename: "WhatsApp Chat - Alice.zip",
      chatFilename: "_chat.txt",
      messages: [message("Alice")],
    },
    {
      name: "generic filenames",
      participants: ["Alice", "Ralph"],
      filename: "Urlaub.zip",
      chatFilename: "_chat.txt",
      messages: [message("Alice"), message("Ralph")],
    },
    {
      name: "conflicting archive and chat names",
      participants: ["Alice", "Ralph"],
      filename: "WhatsApp Chat - Alice.zip",
      chatFilename: "WhatsApp Chat with Ralph.txt",
      messages: [message("Alice"), message("Ralph")],
    },
  ])("does not guess for $name", ({ participants, filename, chatFilename, messages }) => {
    expect(resolveSelfIdentity({ participants, filename, chatFilename, messages })).toEqual({ source: "unresolved" });
  });
});

describe("message direction", () => {
  it("classifies sender, receiver context and system records consistently", () => {
    expect(messageDirection(message("Ralph"), "Ralph")).toBe("outgoing");
    expect(messageDirection(message("Mia"), "Ralph")).toBe("incoming");
    expect(messageDirection(message(null), "Ralph")).toBe("system");
    expect(messageDirection(message("Mia"), "")).toBe("unknown");
    expect(messageDirection(message("Mia"), SELF_NOT_IN_EXPORT)).toBe("incoming");
  });
});
