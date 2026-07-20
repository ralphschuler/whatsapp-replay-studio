import { describe, expect, it } from "vitest";
import {
  animatedFrameIndex,
  attachmentGroupIndexLabel,
  AssetMediaStore,
  attachmentCardPresentation,
  canvasScale,
  cleanMediaCaption,
  combinedPlaybackDuration,
  fitMediaBox,
  forwardedPresentationLabel,
  isFirstAttachmentGroupItem,
  isLastAttachmentGroupItem,
  isSafeAnimatedImageCycle,
  MAX_ANIMATED_CYCLE_SECONDS,
  MAX_ANIMATED_DECODE_PIXELS,
  MAX_ANIMATED_IMAGE_FRAMES,
  messageGapAfter,
  messageCardPresentation,
  messagesShareAttachmentGroup,
  oversizedBubbleScrollOffset,
  shouldShowMessageTimestamp,
  shouldRenderCircularVideoNote,
} from "../src/renderer";
import type { ChatMessage, ImportedProject } from "../src/types";

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "message-1",
    sourceOrder: 0,
    timestamp: new Date(2026, 6, 20, 10, 0),
    rawTimestamp: "20.07.26 10:00",
    precision: "minute",
    sender: "Ralph",
    text: "Hallo",
    kind: "text",
    warnings: [],
    ...overrides,
  };
}

describe("media captions", () => {
  it("removes a localized inline attachment tag but keeps the caption", () => {
    const message: ChatMessage = {
      id: "m-1",
      sourceOrder: 1,
      timestamp: new Date(2026, 6, 20),
      rawTimestamp: "",
      precision: "second",
      sender: "Ralph",
      text: "Schau mal 😄 \u200e<Anhang: clip.mov>",
      kind: "media",
      attachment: {
        archivePath: "clip.mov",
        displayName: "clip.mov",
        kind: "video",
        mimeType: "video/quicktime",
        size: 100,
        status: "found",
      },
      warnings: [],
    };
    expect(cleanMediaCaption(message)).toBe("Schau mal 😄");
  });

  it("removes the localized angehängt tag from the visible caption", () => {
    const value = message({
      text: "Schau mal \u200e<angehängt: foto.jpg>",
      kind: "media",
      mediaReference: "foto.jpg",
      attachment: {
        archivePath: "foto.jpg",
        displayName: "foto.jpg",
        kind: "image",
        mimeType: "image/jpeg",
        size: 100,
        status: "found",
      },
    });
    expect(cleanMediaCaption(value)).toBe("Schau mal");
  });

  it("does not show strict iOS document metadata as a user caption", () => {
    const value = message({
      text: "A PDF.pdf • \u200e1 page \u200e<attached: some-doc.pdf>",
      kind: "media",
      mediaReference: "some-doc.pdf",
      attachment: {
        archivePath: "some-doc.pdf",
        displayName: "some-doc.pdf",
        kind: "document",
        mimeType: "application/pdf",
        size: 100,
        status: "found",
      },
    });
    expect(cleanMediaCaption(value)).toBe("");
  });

  it("does not repeat a bare attachment filename as its caption", () => {
    const message: ChatMessage = {
      id: "m-2",
      sourceOrder: 2,
      timestamp: new Date(2026, 6, 20),
      rawTimestamp: "",
      precision: "second",
      sender: "Ralph",
      text: "voice.opus",
      kind: "media",
      mediaReference: "voice.opus",
      attachment: {
        archivePath: "voice.opus",
        displayName: "voice.opus",
        kind: "audio",
        mimeType: "audio/opus",
        size: 100,
        status: "found",
      },
      warnings: [],
    };
    expect(cleanMediaCaption(message)).toBe("");
  });
});

describe("media dimensions", () => {
  it("fits landscape and portrait media without changing their aspect ratio", () => {
    const landscape = fitMediaBox(960, 720, 690, 610);
    const portrait = fitMediaBox(720, 960, 690, 610);
    expect(landscape.width / landscape.height).toBeCloseTo(4 / 3, 8);
    expect(portrait.width / portrait.height).toBeCloseTo(3 / 4, 8);
    expect(landscape).toEqual({ width: 690, height: 517.5 });
    expect(portrait).toEqual({ width: 457.5, height: 610 });
  });

  it("keeps landscape exports from scaling the chat beyond the canvas height", () => {
    expect(canvasScale(720, 1280)).toBeCloseTo(2 / 3, 8);
    expect(canvasScale(1080, 1080)).toBe(1);
    expect(canvasScale(1920, 1080)).toBe(1);
  });

  it("rounds only genuinely square video notes", () => {
    expect(shouldRenderCircularVideoNote("video-note", 400, 400)).toBe(true);
    expect(shouldRenderCircularVideoNote("video-note", 400, 380)).toBe(true);
    expect(shouldRenderCircularVideoNote("video-note", 640, 360)).toBe(false);
    expect(shouldRenderCircularVideoNote("video", 400, 400)).toBe(false);
  });

  it("selects animated GIF frames deterministically and loops", () => {
    const durations = [0.1, 0.2, 0.1];
    expect(animatedFrameIndex(durations, 0, 0.4)).toBe(0);
    expect(animatedFrameIndex(durations, 0.1, 0.4)).toBe(1);
    expect(animatedFrameIndex(durations, 0.3, 0.4)).toBe(2);
    expect(animatedFrameIndex(durations, 0.4, 0.4)).toBe(0);
  });

  it("accepts a complete normal animation cycle and rejects unsafe decode work", () => {
    expect(isSafeAnimatedImageCycle(240, 240 * 640 * 480, 8)).toBe(true);
    expect(isSafeAnimatedImageCycle(MAX_ANIMATED_IMAGE_FRAMES + 1, 0, 0)).toBe(false);
    expect(isSafeAnimatedImageCycle(10, MAX_ANIMATED_DECODE_PIXELS + 1, 1)).toBe(false);
    expect(isSafeAnimatedImageCycle(10, 1_000, MAX_ANIMATED_CYCLE_SECONDS + 0.01)).toBe(false);
  });

  it("uses the later end of the video and its offset audio track", () => {
    expect(combinedPlaybackDuration(20, 8, 3)).toBe(20);
    expect(combinedPlaybackDuration(10, 8, 3)).toBe(11);
    expect(combinedPlaybackDuration(5, 8, -2)).toBe(6);
    expect(combinedPlaybackDuration(undefined, 8, 0)).toBe(8);
  });

  it("scrolls an oversized current bubble from its top to its bottom", () => {
    expect(oversizedBubbleScrollOffset(1_400, 800, 0, 10)).toBe(600);
    expect(oversizedBubbleScrollOffset(1_400, 800, 5, 10)).toBeGreaterThan(0);
    expect(oversizedBubbleScrollOffset(1_400, 800, 10, 10)).toBe(0);
    expect(oversizedBubbleScrollOffset(700, 800, 0, 10)).toBe(0);
  });

  it("keeps an unreadable standalone audio attachment required for export", () => {
    const audioMessage: ChatMessage = {
      id: "audio-1",
      sourceOrder: 0,
      timestamp: new Date(2026, 6, 20),
      rawTimestamp: "",
      precision: "second",
      sender: "Ralph",
      text: "voice.opus",
      kind: "media",
      mediaReference: "voice.opus",
      attachment: {
        archivePath: "voice.opus",
        displayName: "voice.opus",
        kind: "audio",
        mimeType: "audio/opus",
        size: 100,
        status: "found",
      },
      warnings: [],
    };
    const project: ImportedProject = {
      filename: "Chat.zip",
      chatFilename: "_chat.txt",
      chatText: "",
      chat: {
        messages: [audioMessage],
        participants: ["Ralph"],
        preamble: [],
        diagnostics: {
          totalLines: 1,
          parsedMessages: 1,
          unparsedPreambleLines: 0,
          invalidTimestampLines: 0,
          dateOrder: "dmy",
          dateOrderAmbiguous: false,
          reversedTimestamps: 0,
          warnings: [],
        },
      },
      assets: [],
      attachmentStats: { matched: 1, missing: 0, ambiguous: 0, unreferenced: 0 },
    };
    const store = new AssetMediaStore(project);
    const scheduled = store.getScheduledAudioAssets({
      events: [{ message: audioMessage, messageIndex: 0, at: 0.6, revealDuration: 0.22, mediaDuration: 4 }],
      duration: 5,
    });
    expect(scheduled).toEqual([{
      at: 0.6,
      path: "voice.opus",
      duration: 4,
      clipStart: 0,
      required: true,
    }]);
    store.dispose();
  });
});

describe("explicit attachment groups", () => {
  function groupItem(index: number, size = 3): ChatMessage {
    return message({
      id: `album-${index}`,
      logicalMessageId: "album",
      attachmentGroup: { id: "album", index, size, kind: "explicit-multi" },
    });
  }

  it("shows sender/caption semantics on the first item and the timestamp on the last", () => {
    const first = groupItem(0);
    const middle = groupItem(1);
    const last = groupItem(2);
    expect(isFirstAttachmentGroupItem(first)).toBe(true);
    expect(isFirstAttachmentGroupItem(middle)).toBe(false);
    expect(isLastAttachmentGroupItem(middle)).toBe(false);
    expect(isLastAttachmentGroupItem(last)).toBe(true);
    expect(shouldShowMessageTimestamp(first)).toBe(false);
    expect(shouldShowMessageTimestamp(last)).toBe(true);
  });

  it("creates stable visible indices and a tighter gap only between consecutive siblings", () => {
    const first = groupItem(0);
    const middle = groupItem(1);
    const last = groupItem(2);
    expect(attachmentGroupIndexLabel(first)).toBe("1/3");
    expect(attachmentGroupIndexLabel(last)).toBe("3/3");
    expect(messagesShareAttachmentGroup(first, middle)).toBe(true);
    expect(messagesShareAttachmentGroup(first, last)).toBe(false);
    expect(messageGapAfter(first, middle, 2)).toBe(10);
    expect(messageGapAfter(middle, message(), 2)).toBe(30);
  });

  it("keeps ordinary messages self-contained", () => {
    const ordinary = message();
    expect(isFirstAttachmentGroupItem(ordinary)).toBe(true);
    expect(isLastAttachmentGroupItem(ordinary)).toBe(true);
    expect(attachmentGroupIndexLabel(ordinary)).toBeUndefined();
    expect(shouldShowMessageTimestamp(ordinary)).toBe(true);
  });

  it("labels frequently forwarded messages once at the start of a group", () => {
    expect(forwardedPresentationLabel(message({ forwarded: true }))).toBe("↪  WEITERGELEITET");
    expect(forwardedPresentationLabel(message({ forwarded: true, frequentlyForwarded: true }))).toBe("↪  HÄUFIG WEITERGELEITET");
    expect(forwardedPresentationLabel({ ...groupItem(1), forwarded: true, frequentlyForwarded: true })).toBeUndefined();
  });
});

describe("semantic message card presentations", () => {
  it.each([
    [
      { type: "call" as const, variant: "missed-video", title: "Verpasster Videoanruf", detail: "Tap to call back" },
      { type: "call", icon: "▰", title: "Verpasster Videoanruf", detail: "Tap to call back", items: [], accent: "#25a56a" },
    ],
    [
      { type: "location" as const, variant: "pin", title: "Standort", detail: "52.52001, 13.40495", body: "Alexanderplatz" },
      { type: "location", icon: "●", title: "Standort", detail: "52.52001, 13.40495", body: "Alexanderplatz", items: [], accent: "#348dcc" },
    ],
    [
      { type: "contact" as const, title: "Kontakt", detail: "Max Mustermann" },
      { type: "contact", icon: "●", title: "Kontakt", detail: "Max Mustermann", items: [], accent: "#7c5ac7" },
    ],
    [
      { type: "poll" as const, title: "Umfrage", detail: "Wohin?", items: ["Berlin", "Hamburg"] },
      { type: "poll", icon: "▥", title: "Umfrage", detail: "Wohin?", items: ["Berlin", "Hamburg"], accent: "#00a884" },
    ],
    [
      { type: "reaction" as const, title: "Reaktion", detail: "❤️", body: "Bis gleich" },
      { type: "reaction", icon: "♥", title: "Reaktion", detail: "❤️", body: "Bis gleich", items: [], accent: "#e09f25" },
    ],
    [
      { type: "payment" as const, variant: "failed", title: "Zahlung fehlgeschlagen", detail: "10,00 €" },
      { type: "payment", icon: "€", title: "Zahlung fehlgeschlagen", detail: "10,00 €", items: [], accent: "#d86b65" },
    ],
    [
      { type: "link" as const, variant: "url", title: "Link", detail: "example.com", body: "https://example.com" },
      { type: "link", icon: "↗", title: "Link", detail: "example.com", body: "https://example.com", items: [], accent: "#348dcc" },
    ],
    [
      { type: "invite" as const, variant: "group", title: "Gruppeneinladung", detail: "chat.whatsapp.com" },
      { type: "invite", icon: "+", title: "Gruppeneinladung", detail: "chat.whatsapp.com", items: [], accent: "#25a56a" },
    ],
    [
      { type: "business" as const, variant: "product", title: "Produkt", detail: "Sneaker", items: ["Preis: 89 €"] },
      { type: "business", icon: "▤", title: "Produkt", detail: "Sneaker", items: ["Preis: 89 €"], accent: "#7c5ac7" },
    ],
    [
      { type: "interactive" as const, variant: "buttons", title: "Auswahlbuttons", items: ["Ja", "Nein"] },
      { type: "interactive", icon: "☷", title: "Auswahlbuttons", items: ["Ja", "Nein"], accent: "#00a884" },
    ],
    [
      { type: "template" as const, variant: "named", title: "Nachrichtenvorlage", detail: "order_update" },
      { type: "template", icon: "▤", title: "Nachrichtenvorlage", detail: "order_update", items: [], accent: "#7c5ac7" },
    ],
    [
      { type: "event" as const, variant: "group-created", title: "Gruppe erstellt", detail: "Ralph hat die Gruppe erstellt" },
      { type: "event", icon: "i", title: "Gruppe erstellt", detail: "Ralph hat die Gruppe erstellt", items: [], accent: "#647985" },
    ],
    [
      { type: "view-once" as const, title: "Einmalansicht", detail: "Im Export nicht verfügbar" },
      { type: "view-once", icon: "1", title: "Einmalansicht", detail: "Im Export nicht verfügbar", items: [], accent: "#7c5ac7" },
    ],
    [
      { type: "unsupported" as const, variant: "waiting", title: "Nachricht noch nicht verfügbar", detail: "Waiting for this message" },
      { type: "unsupported", icon: "!", title: "Nachricht noch nicht verfügbar", detail: "Waiting for this message", items: [], accent: "#d97706" },
    ],
  ])("maps semantic metadata to a stable card contract", (semantic, expected) => {
    expect(messageCardPresentation(message({ semantic }))).toEqual(expected);
  });

  it("distinguishes messages deleted by the selected sender from other deletions", () => {
    expect(messageCardPresentation(message({ kind: "deleted", text: "Du hast diese Nachricht gelöscht." }))).toMatchObject({
      type: "deleted",
      title: "Von dir gelöscht",
      icon: "⌫",
    });
    expect(messageCardPresentation(message({ kind: "deleted", text: "This message was deleted." }))).toMatchObject({
      type: "deleted",
      title: "Nachricht gelöscht",
      icon: "⌫",
    });
  });

  it("uses distinct payment accents for pending and cancelled states", () => {
    expect(messageCardPresentation(message({
      semantic: { type: "payment", variant: "pending", title: "Zahlung ausstehend" },
    }))?.accent).toBe("#e09f25");
    expect(messageCardPresentation(message({
      semantic: { type: "payment", variant: "cancelled", title: "Zahlung storniert" },
    }))?.accent).toBe("#d86b65");
  });

  it("creates an explicit omitted-media card without pretending an attachment exists", () => {
    expect(messageCardPresentation(message({
      kind: "media-omitted",
      text: "Dokument weggelassen\nAnbei die Unterlagen",
      mediaHint: "document",
    }))).toEqual({
      type: "omitted",
      icon: "▧",
      title: "Dokument nicht enthalten",
      detail: "WhatsApp hat für diesen Eintrag keine eindeutig zuordenbare Datei exportiert.",
      body: "Anbei die Unterlagen",
      items: [],
      accent: "#75858e",
    });
  });

  it("labels an omitted contact card separately from a generic document", () => {
    expect(messageCardPresentation(message({
      kind: "media-omitted",
      text: "Kontaktkarte weggelassen",
      mediaHint: "document",
      mediaRole: "contact",
    }))).toMatchObject({ title: "Kontaktkarte nicht enthalten" });
  });

  it("returns no semantic card for a normal message", () => {
    expect(messageCardPresentation(message())).toBeUndefined();
  });
});

describe("attachment card presentations", () => {
  function withAttachment(
    displayName: string,
    kind: "image" | "video" | "audio" | "document" | "sticker",
    status: "found" | "missing" | "ambiguous" = "found",
  ): ChatMessage {
    return message({
      kind: "media",
      attachment: {
        archivePath: status === "missing" ? "" : displayName,
        displayName,
        kind,
        mimeType: "application/octet-stream",
        size: status === "missing" ? 0 : 123,
        status,
      },
    });
  }

  it.each([
    ["Max Mustermann.vcf", "document", "found", { icon: "●", title: "KONTAKT", detail: "Max Mustermann.vcf" }],
    ["Vertrag.PDF", "document", "found", { icon: "▤", title: "PDF-DOKUMENT", detail: "Vertrag.PDF" }],
    ["clip.mp4", "video", "found", { icon: "▶", title: "VIDEO", detail: "clip.mp4" }],
    ["voice.opus", "audio", "found", { icon: "▶", title: "AUDIO", detail: "voice.opus" }],
    ["photo.jpg", "image", "found", { icon: "▧", title: "BILD", detail: "photo.jpg" }],
    ["STK-1.webp", "sticker", "found", { icon: "▧", title: "STICKER", detail: "STK-1.webp" }],
    ["missing.pdf", "document", "missing", { icon: "!", title: "DATEI FEHLT", detail: "missing.pdf" }],
    ["duplicate.jpg", "image", "ambiguous", { icon: "?", title: "DATEI NICHT EINDEUTIG", detail: "duplicate.jpg" }],
  ] as const)("describes %s (%s, %s)", (displayName, kind, status, expected) => {
    expect(attachmentCardPresentation(withAttachment(displayName, kind, status))).toEqual(expected);
  });

  it("prioritizes a missing status over the file-specific contact presentation", () => {
    expect(attachmentCardPresentation(withAttachment("missing.vcf", "document", "missing"))).toEqual({
      icon: "!",
      title: "DATEI FEHLT",
      detail: "missing.vcf",
    });
  });

  it.each([
    ["voice-note", "SPRACHNACHRICHT"],
    ["video-note", "VIDEONOTIZ"],
    ["animated-image", "GIF / ANIMATION"],
  ] as const)("uses the %s media role in attachment cards", (mediaRole, title) => {
    const kind = mediaRole === "voice-note" ? "audio" : "video";
    const value = withAttachment(mediaRole === "voice-note" ? "PTT.opus" : "clip.mp4", kind);
    value.mediaRole = mediaRole;
    expect(attachmentCardPresentation(value)).toMatchObject({ title });
  });

  it("returns no attachment card when the message has no attachment", () => {
    expect(attachmentCardPresentation(message())).toBeUndefined();
  });
});
