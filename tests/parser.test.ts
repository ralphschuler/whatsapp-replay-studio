import { describe, expect, it } from "vitest";
import { mediaPresentationRole, parseChat, readHeader } from "../src/parser";

describe("WhatsApp parser", () => {
  it("parses German Android exports and multiline messages", () => {
    const chat = parseChat("20.07.26, 09:03 - Ralph: Erste Zeile\nzweite Zeile\n\n20.07.26, 09:04 - Mia: Antwort");
    expect(chat.messages).toHaveLength(2);
    expect(chat.messages[0]?.sender).toBe("Ralph");
    expect(chat.messages[0]?.text).toBe("Erste Zeile\nzweite Zeile");
    expect(chat.messages[0]?.timestamp.getHours()).toBe(9);
  });

  it("parses iOS brackets, seconds, control chars and 12-hour time", () => {
    const chat = parseChat("\u200e[7/20/26, 12:03:04 AM] Alice: Night\n[7/20/26, 12:03:04 PM] Bob: Day", "mdy");
    expect(chat.messages).toHaveLength(2);
    expect(chat.messages[0]?.timestamp.getHours()).toBe(0);
    expect(chat.messages[1]?.timestamp.getHours()).toBe(12);
    expect(chat.messages[0]?.precision).toBe("second");
  });

  it("detects MDY from an unambiguous date", () => {
    const chat = parseChat("4/13/26, 9:03 PM - Alice: Hi");
    expect(chat.diagnostics.dateOrder).toBe("mdy");
    expect(chat.diagnostics.dateOrderAmbiguous).toBe(false);
    expect(chat.messages[0]?.timestamp.getMonth()).toBe(3);
  });

  it("marks fully ambiguous slash dates", () => {
    const chat = parseChat("3/4/26, 09:03 - Ralph: Hallo");
    expect(chat.diagnostics.dateOrderAmbiguous).toBe(true);
    expect(chat.diagnostics.dateOrder).toBe("dmy");
  });

  it("keeps source order for equal and reversed timestamps", () => {
    const chat = parseChat("20.07.26, 09:05 - A: Eins\n20.07.26, 09:05 - B: Zwei\n20.07.26, 09:04 - A: Drei");
    expect(chat.messages.map((message) => message.text)).toEqual(["Eins", "Zwei", "Drei"]);
    expect(chat.diagnostics.reversedTimestamps).toBe(1);
  });

  it("recognizes system messages and media attachments", () => {
    const chat = parseChat("20.07.26, 09:03 - Ralph hat die Gruppe erstellt\n20.07.26, 09:04 - Ralph: <attached: IMG-1234.jpg>\nCaption");
    expect(chat.messages[0]?.kind).toBe("system");
    expect(chat.messages[1]?.kind).toBe("media");
    expect(chat.messages[1]?.mediaReference).toBe("IMG-1234.jpg");
    expect(chat.messages[1]?.text).toContain("Caption");
  });

  it("recognizes localized iOS attachment tags", () => {
    const chat = parseChat("[17.07.26, 09:57:57] Ralph: \u200e<Anhang: 00003018-PHOTO-2026-07-17-09-57-57.jpg>");
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0]?.kind).toBe("media");
    expect(chat.messages[0]?.mediaReference).toBe("00003018-PHOTO-2026-07-17-09-57-57.jpg");
    expect(chat.messages[0]?.mediaHint).toBe("image");
  });

  it("recognizes the localized angehängt attachment tag", () => {
    const message = parseChat("[17.07.26, 09:57:57] Ralph: \u200e<angehängt: IMG-20260720-WA0001.jpg>").messages[0];
    expect(message).toMatchObject({ kind: "media", mediaReference: "IMG-20260720-WA0001.jpg", mediaHint: "image" });
  });

  it("recognizes explicitly attached documents without a file extension", () => {
    const chat = parseChat([
      "[17.07.26, 09:57:57] Ralph: <attached: LICENSE>",
      "[17.07.26, 09:57:58] Ralph: README (file attached)",
    ].join("\n"));
    expect(chat.messages.map((message) => ({
      kind: message.kind,
      reference: message.mediaReference,
      hint: message.mediaHint,
    }))).toEqual([
      { kind: "media", reference: "LICENSE", hint: "document" },
      { kind: "media", reference: "README", hint: "document" },
    ]);
  });

  it("does not classify ordinary angle-bracket text as media", () => {
    const chat = parseChat("[17.07.26, 09:57:57] Ralph: <Hinweis: report.pdf>");
    expect(chat.messages[0]?.kind).toBe("text");
    expect(chat.messages[0]?.mediaReference).toBeUndefined();
  });

  it("does not classify an omitted-marker phrase inside normal prose", () => {
    const chat = parseChat("20.07.26, 09:03 - Ralph: Im Bericht steht photo omitted als Beispiel");
    expect(chat.messages[0]?.kind).toBe("text");
    expect(chat.messages[0]?.mediaHint).toBeUndefined();
  });

  it("does not mistake a filename mentioned in ordinary prose for an attachment", () => {
    const chat = parseChat("20.07.26, 09:03 - Ralph: Bitte öffne report.csv morgen");
    expect(chat.messages[0]?.kind).toBe("text");
    expect(chat.messages[0]?.mediaReference).toBeUndefined();
  });

  it("recognizes localized deleted-message markers with punctuation", () => {
    const chat = parseChat("20.07.26, 09:03 - Ralph: Diese Nachricht wurde gelöscht.\n20.07.26, 09:04 - Mia: This message was deleted!\n20.07.26, 09:05 - Mia: Message deleted");
    expect(chat.messages.map((message) => message.kind)).toEqual(["deleted", "deleted", "deleted"]);
  });

  it("recognizes deletion-for-everyone markers", () => {
    const chat = parseChat([
      "20.07.26, 09:06 - Ralph: Diese Nachricht wurde für alle gelöscht.",
      "20.07.26, 09:07 - Ralph: Du hast diese Nachricht für alle gelöscht.",
    ].join("\n"));
    expect(chat.messages.map((message) => message.kind)).toEqual(["deleted", "deleted"]);
  });

  it("shows an empty exported record as unknown content instead of an empty bubble", () => {
    const message = parseChat("20.07.26, 09:03 - Ralph: ").messages[0];
    expect(message).toMatchObject({
      sender: "Ralph",
      text: "",
      kind: "unknown",
      semantic: {
        type: "unsupported",
        variant: "not-exported",
        title: "Nicht exportierter WhatsApp-Inhalt",
      },
    });
  });

  it("does not treat log timestamps as WhatsApp headers", () => {
    const chat = parseChat("20.07.26, 09:03 - Ralph: Log:\n2016-04-29 10:30:00\nhttps://x.test:443/a");
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0]?.text).toContain("2016-04-29 10:30:00");
    expect(chat.messages[0]?.text).toContain("https://x.test:443/a");
  });

  it("resolves repeated participant names containing a colon without consuming message colons", () => {
    const chat = parseChat([
      "20.07.26, 09:03 - ACME: Support: Erste Antwort",
      "20.07.26, 09:04 - Ralph: Normal",
      "20.07.26, 09:05 - ACME: Support: Zweite Antwort",
      "20.07.26, 09:06 - Ralph: Preis: 12,50 €",
    ].join("\n"));
    expect(chat.messages.map(({ sender, text }) => ({ sender, text }))).toEqual([
      { sender: "ACME: Support", text: "Erste Antwort" },
      { sender: "Ralph", text: "Normal" },
      { sender: "ACME: Support", text: "Zweite Antwort" },
      { sender: "Ralph", text: "Preis: 12,50 €" },
    ]);
  });

  it("rejects impossible calendar dates", () => {
    const chat = parseChat("31.02.26, 09:03 - Ralph: Unmöglich");
    expect(chat.messages).toHaveLength(0);
    expect(chat.diagnostics.invalidTimestampLines).toBe(1);
  });

  it("supports dotted time separators", () => {
    const header = readHeader("13.06.18 21.25.15 - Ralph: Test");
    expect(header?.time).toBe("21:25:15");
  });

  describe("semantic message types", () => {
    it.each([
      {
        name: "German voice call",
        line: "20.07.26, 10:00 - Ralph: Verpasster Sprachanruf, Zum Zurückrufen tippen",
        expected: {
          type: "call",
          variant: "missed-voice",
          title: "Verpasster Sprachanruf",
          detail: "Zum Zurückrufen tippen",
        },
      },
      {
        name: "English video call",
        line: "7/20/26, 10:01 AM - Alice: Missed video call, Tap to call back",
        order: "mdy" as const,
        expected: {
          type: "call",
          variant: "missed-video",
          title: "Verpasster Videoanruf",
          detail: "Tap to call back",
        },
      },
      {
        name: "German location",
        line: "20.07.26, 10:02 - Ralph: Standort: https://maps.google.com/?q=52.520008,13.404954",
        expected: {
          type: "location",
          variant: "pin",
          title: "Standort",
          detail: "52.52001, 13.40495",
        },
      },
      {
        name: "English live location",
        line: "7/20/26, 10:03 AM - Alice: Live location shared: King's Cross",
        order: "mdy" as const,
        expected: {
          type: "location",
          variant: "live",
          title: "Live-Standort",
          body: "King's Cross",
        },
      },
      {
        name: "German poll",
        line: "20.07.26, 10:04 - Ralph: Umfrage: Wohin fahren wir?\n- Berlin\n- Hamburg",
        expected: {
          type: "poll",
          title: "Umfrage",
          detail: "Wohin fahren wir?",
          items: ["Berlin", "Hamburg"],
        },
      },
      {
        name: "English poll",
        line: "7/20/26, 10:05 AM - Alice: Poll\nLunch?\n1. Pizza\n2. Salad",
        order: "mdy" as const,
        expected: {
          type: "poll",
          title: "Umfrage",
          detail: "Lunch?",
          items: ["Pizza", "Salad"],
        },
      },
      {
        name: "native field poll",
        line: "7/20/26, 10:05 AM - Alice: POLL:\nQUESTION: Lunch?\nOPTION: Pizza (3 votes)\nOPTION: Salad (2 votes)",
        order: "mdy" as const,
        expected: {
          type: "poll",
          title: "Umfrage",
          detail: "Lunch?",
          items: ["Pizza (3 votes)", "Salad (2 votes)"],
        },
      },
      {
        name: "strict localized poll",
        line: "20.07.26, 10:05 - Alice: ENCUESTA:\nUna pregunta\nOPCIÓN: Opción A (0 votos)\nOPCIÓN: Opción B (1 voto)\nOPCIÓN: Opción C (2 votos)",
        expected: {
          type: "poll",
          title: "Umfrage",
          detail: "Una pregunta",
          items: ["Opción A (0 votos)", "Opción B (1 voto)", "Opción C (2 votos)"],
        },
      },
      {
        name: "German reaction",
        line: "20.07.26, 10:06 - Ralph: Mit 👍 auf „Hallo“ reagiert",
        expected: {
          type: "reaction",
          title: "Reaktion",
          detail: "👍",
          body: "Hallo",
        },
      },
      {
        name: "English reaction",
        line: "7/20/26, 10:07 AM - Alice: Reacted ❤️ to \"See you soon\"",
        order: "mdy" as const,
        expected: {
          type: "reaction",
          title: "Reaktion",
          detail: "❤️",
          body: "See you soon",
        },
      },
      {
        name: "German contact",
        line: "20.07.26, 10:08 - Ralph: Kontaktkarte geteilt: Max Mustermann",
        expected: {
          type: "contact",
          title: "Kontakt",
          detail: "Max Mustermann",
        },
      },
      {
        name: "English contact",
        line: "7/20/26, 10:09 AM - Alice: Contact card shared: Jane Doe",
        order: "mdy" as const,
        expected: {
          type: "contact",
          title: "Kontakt",
          detail: "Jane Doe",
        },
      },
      {
        name: "German payment",
        line: "20.07.26, 10:10 - Ralph: Zahlung erhalten: 12,50 €",
        expected: {
          type: "payment",
          variant: "received",
          title: "Zahlung erhalten",
          detail: "12,50 €",
        },
      },
      {
        name: "English failed payment",
        line: "7/20/26, 10:11 AM - Alice: Payment failed: GBP 10.00",
        order: "mdy" as const,
        expected: {
          type: "payment",
          variant: "failed",
          title: "Zahlung fehlgeschlagen",
          detail: "GBP 10.00",
        },
      },
    ])("recognizes $name", ({ line, order, expected }) => {
      const message = parseChat(line, order ?? "auto").messages[0];
      expect(message?.semantic).toMatchObject(expected);
      expect(message?.text).toBe(line.slice(line.indexOf(": ") + 2));
    });

    it.each([
      [
        "German group event",
        "20.07.26, 11:00 - Ralph hat die Gruppe „Urlaub“ erstellt",
        "group-created",
        "Gruppe erstellt",
      ],
      [
        "English encryption event",
        "7/20/26, 11:01 AM - Messages and calls are end-to-end encrypted. No one outside of this chat can read or listen to them.",
        "encryption",
        "Ende-zu-Ende-Verschlüsselung",
      ],
    ])("recognizes %s as a senderless system event", (_name, line, variant, title) => {
      const message = parseChat(line, line.includes("AM") ? "mdy" : "auto").messages[0];
      expect(message?.sender).toBeNull();
      expect(message?.kind).toBe("system");
      expect(message?.semantic).toMatchObject({ type: "event", variant, title });
    });

    it("normalizes strongly marked iOS service events with a syntactic sender", () => {
      const chat = parseChat([
        "[20.07.2026, 11:00:00] Cherries for the title: \u200eYou created this group",
        "[20.07.2026, 11:01:00] Alice: \u200eAlice changed the group name to \"Roadtrip\"",
        "[20.07.2026, 11:02:00] Alice: \u200eAlice pinned a message",
        "[20.07.2026, 11:03:00] \u200eYou: \u200eYou pinned a message",
        "[20.07.2026, 11:04:00] Bob: \u200eYour security code with Bob changed. Tap to learn more.",
        "[20.07.2026, 11:05:00] Roadtrip: \u200eAlice left",
        "[20.07.2026, 11:06:00] Roadtrip: \u200eAlice turned off disappearing messages",
        "[20.07.2026, 11:07:00] Roadtrip: \u200eAlice changed their phone number. Tap to message the new number.",
        "[20.07.2026, 11:08:00] Roadtrip: \u200eAlice blocked this contact",
        "[20.07.2026, 11:09:00] Roadtrip: \u200eAlice enabled advanced chat privacy",
        "[20.07.2026, 11:10:00] Group: \u200eMessages and calls are end-to-end encrypted. Only people in this chat can read, listen to, or share them.",
        "[20.07.2026, 11:11:00] Group: \u200ePerson 2 changed their phone number to a new number",
        "[20.07.2026, 11:12:00] Group: \u200eAlice hat erweiterten Chat-Datenschutz aktiviert",
      ].join("\n"));
      expect(chat.messages.map((message) => [message.sender, message.kind, message.semantic?.variant])).toEqual([
        [null, "system", "group-created"],
        [null, "system", "subject-changed"],
        [null, "system", "pinned"],
        [null, "system", "pinned"],
        [null, "system", "security"],
        [null, "system", "participant-left"],
        [null, "system", "disappearing-off"],
        [null, "system", "number-changed"],
        [null, "system", "blocked"],
        [null, "system", "privacy"],
        [null, "system", "encryption"],
        [null, "system", "number-changed"],
        [null, "system", "privacy"],
      ]);
      expect(chat.participants).toEqual([]);
    });

    it("does not promote ordinary sender text even when it contains a bidi mark", () => {
      const message = parseChat("[20.07.2026, 11:05:00] Alice: \u200eAlice left the keys on the table").messages[0];
      expect(message).toMatchObject({ sender: "Alice", kind: "text" });
      expect(message?.semantic).toBeUndefined();
    });

    it.each([
      [
        "German view-once",
        "20.07.26, 11:02 - Ralph: Foto zur einmaligen Ansicht nicht verfügbar.",
        { type: "view-once", title: "Einmalansicht" },
        "media-omitted",
      ],
      [
        "English view-once",
        "7/20/26, 11:03 AM - Alice: <View once video omitted>",
        { type: "view-once", title: "Einmalansicht" },
        "media-omitted",
      ],
      [
        "German waiting marker",
        "20.07.26, 11:04 - Ralph: Warte auf diese Nachricht. Das kann einen Moment dauern.",
        { type: "unsupported", variant: "waiting", title: "Nachricht noch nicht verfügbar" },
        "text",
      ],
      [
        "English unsupported marker",
        "7/20/26, 11:05 AM - Alice: This message is not supported on this version of WhatsApp.",
        { type: "unsupported", variant: "version", title: "Nicht unterstützte Nachricht" },
        "text",
      ],
    ])("recognizes %s", (_name, line, semantic, kind) => {
      const message = parseChat(line, line.includes("AM") ? "mdy" : "auto").messages[0];
      expect(message?.kind).toBe(kind);
      expect(message?.semantic).toMatchObject(semantic);
    });

    it("preserves a caption around an exported view-once marker", () => {
      const body = "Nur kurz sichtbar\n\u200e<View once video omitted>";
      const message = parseChat(`20.07.26, 11:05 - Ralph: ${body}`).messages[0];
      expect(message).toMatchObject({ kind: "media-omitted", mediaHint: "video", text: body });
      expect(message?.semantic).toMatchObject({ type: "view-once", body: "Nur kurz sichtbar" });
    });

    it.each([
      ["7/20/26, 11:06 AM - Alice: You missed a voice call", "mdy", "missed-voice"],
      ["20.07.26, 11:07 - Ralph: Du hast einen Videoanruf verpasst", "auto", "missed-video"],
      ["20.07.26, 11:08 - Ralph: Ausgehender Sprachanruf. 2 Min.", "auto", "outgoing-voice"],
      ["7/20/26, 11:08 AM - Ralph: Missed group video call", "mdy", "missed-video"],
      ["20.07.26, 11:08 - Ralph: Verpasster Gruppen-Sprachanruf", "auto", "missed-voice"],
    ])("recognizes additional call marker: %s", (line, order, variant) => {
      expect(parseChat(line, order as "auto" | "mdy").messages[0]?.semantic).toMatchObject({ type: "call", variant });
    });

    it("recognizes a removed reaction without inventing a target relationship", () => {
      const message = parseChat("20.07.26, 11:09 - Ralph: Du hast deine Reaktion ❤️ von „Bis gleich“ entfernt").messages[0];
      expect(message?.semantic).toMatchObject({
        type: "reaction",
        variant: "removed",
        title: "Reaktion entfernt",
        detail: "❤️",
        body: "Bis gleich",
      });
      expect(message?.text).toBe("Du hast deine Reaktion ❤️ von „Bis gleich“ entfernt");
    });

    it.each([
      ["20.07.26, 11:10 - Ralph hat das Gruppenbild geändert", "icon-changed"],
      ["20.07.26, 11:11 - Ralph hat den Einladungslink zurückgesetzt", "invite-link-changed"],
      ["7/20/26, 11:12 AM - Alice unblocked this contact", "unblocked"],
      ["7/20/26, 11:13 AM - Alice created an event", "event-created"],
      ["7/20/26, 11:14 AM - Alice joined using this group's invite link", "participant-joined"],
      ["7/20/26, 11:15 AM - Alice joined using a group link.", "participant-joined"],
      ["20.07.26, 11:16 - Alice hat den Betreff von „Alt“ zu „Neu“ geändert", "subject-changed"],
      ["20.07.26, 11:17 - Alice hat diesen Gruppen-Einladungslink widerrufen.", "invite-link-changed"],
      ["20.07.26, 11:18 - Du bist kein*e Admin mehr.", "admin-changed"],
      ["20.07.26, 11:19 - Alice hat eine neue Telefonnummer. Tippe, um eine Nachricht zu schreiben.", "number-changed"],
      ["20.07.26, 11:20 - + 49 000 000 hat zu 004900000000 gewechselt.", "number-changed"],
      ["7/20/26, 11:21 AM - Alice updated the message timer. New messages will disappear after 7 days.", "disappearing-timer"],
    ])("recognizes additional senderless event: %s", (line, variant) => {
      const message = parseChat(line, line.includes("AM") ? "mdy" : "auto").messages[0];
      expect(message).toMatchObject({ sender: null, kind: "system" });
      expect(message?.semantic).toMatchObject({ type: "event", variant });
    });

    it.each([
      "20.07.26, 11:14 - Ralph: Diese Nachricht wurde von einem Admin gelöscht.",
      "7/20/26, 11:15 AM - Alice: This message was deleted by an admin.",
    ])("recognizes admin deletion markers: %s", (line) => {
      expect(parseChat(line, line.includes("AM") ? "mdy" : "auto").messages[0]?.kind).toBe("deleted");
    });

    it("recognizes the extended unsupported-version marker", () => {
      const message = parseChat("7/20/26, 11:16 AM - Alice: You received a message but your version of WhatsApp doesn't support it. Update WhatsApp to view this message.", "mdy").messages[0];
      expect(message?.semantic).toMatchObject({ type: "unsupported", variant: "version" });
    });

    it.each([
      {
        name: "structured event",
        body: "Event: Sommerfest\nDatum: 25.07.2026\nOrt: Berlin",
        expected: { type: "event", variant: "chat-event", title: "Ereignis", detail: "Sommerfest", items: ["Datum: 25.07.2026", "Ort: Berlin"] },
      },
      {
        name: "native field event",
        body: "EVENT\nTITLE: Sommerfest\nSTART: 25.07.2026 18:00\nLOCATION: Berlin",
        expected: { type: "event", variant: "chat-event", title: "Ereignis", detail: "Sommerfest" },
      },
      {
        name: "export-native event fields",
        body: "EVENT: Demo\nEvent Start time: 1765279800000\nEvent Cancelled: false\nEvent Description: Tomorrow afternoon\nEvent Location Name: C-301\nEvent Join Link: https://example.test/join",
        expected: { type: "event", variant: "chat-event", title: "Ereignis", detail: "Demo" },
      },
      {
        name: "event RSVP",
        body: "RSVP: Going: Sommerfest\n25.07.2026",
        expected: { type: "event", variant: "rsvp-going", title: "Ereignis zugesagt", detail: "Sommerfest", items: ["25.07.2026"] },
      },
      {
        name: "business product",
        body: "Produkt: Sneaker\nPreis: 89,00 €\nMenge: 1",
        expected: { type: "business", variant: "product", title: "Produkt", detail: "Sneaker", items: ["Preis: 89,00 €", "Menge: 1"] },
      },
      {
        name: "business order",
        body: "Order: #1234\nStatus: shipped\nTotal: EUR 42.00",
        expected: { type: "business", variant: "order", title: "Bestellung", detail: "#1234" },
      },
      {
        name: "interactive buttons",
        body: "Button message: Termin wählen\n[ ] Montag\n[ ] Dienstag",
        expected: { type: "interactive", variant: "buttons", title: "Auswahlbuttons", detail: "Termin wählen", items: ["○ Montag", "○ Dienstag"] },
      },
      {
        name: "selected interactive button",
        body: "Button message: Termin wählen\n[x] Montag\n[ ] Dienstag",
        expected: { type: "interactive", variant: "buttons", items: ["✓ Montag", "○ Dienstag"] },
      },
      {
        name: "button reply",
        body: "Button reply: Montag",
        expected: { type: "interactive", variant: "reply-button", title: "Button-Antwort", items: ["✓ Montag"] },
      },
      {
        name: "omitted product card",
        body: "<Product message omitted>",
        expected: { type: "business", variant: "omitted-product", title: "Produkt nicht enthalten" },
      },
      {
        name: "omitted list card",
        body: "<List message omitted>",
        expected: { type: "interactive", variant: "omitted-list", title: "Liste nicht enthalten" },
      },
      {
        name: "WhatsApp group invite",
        body: "https://chat.whatsapp.com/AbCdEf123",
        expected: { type: "invite", variant: "group", title: "Gruppeneinladung", detail: "chat.whatsapp.com" },
      },
      {
        name: "standalone web link",
        body: "https://example.com/article?id=7",
        expected: { type: "link", variant: "url", title: "Link", detail: "example.com" },
      },
    ])("recognizes $name without inventing missing data", ({ body, expected }) => {
      const message = parseChat(`20.07.26, 11:30 - Ralph: ${body}`).messages[0];
      expect(message?.semantic).toMatchObject(expected);
      expect(message?.text).toBe(body);
    });
  });

  describe("omitted media variants", () => {
    it.each([
      ["Bild weggelassen", "image"],
      ["<image omitted>", "image"],
      ["Audio nicht enthalten.", "audio"],
      ["<Sticker omitted>", "sticker"],
      ["GIF omitted", "image"],
      ["<Document omitted>", "document"],
      ["Kontaktkarte weggelassen", "document"],
      ["<Video note omitted>", "video"],
      ["Videonachricht weggelassen", "video"],
      ["Videonotiz weggelassen", "video"],
      ["Vertrag.pdf weggelassen", "document"],
      ["Vertrag.pdf • 2 Seiten Dokument weggelassen", "document"],
      ["Contract.pdf • 2 pages document omitted", "document"],
      ["<Medien weggelassen>", undefined],
    ])("classifies %j without inventing an attachment", (body, mediaHint) => {
      const message = parseChat(`20.07.26, 12:00 - Ralph: ${body}`).messages[0];
      expect(message).toMatchObject({ kind: "media-omitted", mediaHint });
      expect(message?.attachment).toBeUndefined();
      expect(message?.text).toBe(body);
    });

    it("accepts harmless whitespace inside the generic omitted wrapper", () => {
      const message = parseChat("20.07.26, 12:01 - Ralph: \u200E< Media omitted >\u200F").messages[0];
      expect(message).toMatchObject({ kind: "media-omitted" });
      expect(message?.mediaHint).toBeUndefined();
    });

    it("keeps an iOS caption that appears before its omitted-media marker", () => {
      const body = "Sommerurlaub\n\u200eimage omitted";
      const message = parseChat(`20.07.26, 12:02 - Ralph: ${body}`).messages[0];
      expect(message).toMatchObject({ kind: "media-omitted", mediaHint: "image", text: body });
      expect(message?.displayText).toBe("image omitted\nSommerurlaub");
    });

    it("keeps an inline iOS caption before a bidi-separated omitted marker", () => {
      const body = "Bildunterschrift \u200eimage omitted";
      const message = parseChat(`20.07.26, 12:03 - Ralph: ${body}`).messages[0];
      expect(message).toMatchObject({ kind: "media-omitted", mediaHint: "image", text: body });
      expect(message?.displayText).toBe("image omitted\nBildunterschrift");
    });
  });

  describe("lossless message decorations", () => {
    it.each([
      {
        name: "German forwarded marker",
        body: "Weitergeleitet\nOriginaltext",
        expected: { forwarded: true, displayText: "Originaltext" },
      },
      {
        name: "English forwarded marker",
        body: "Forwarded - Original text",
        expected: { forwarded: true, displayText: "Original text" },
      },
      {
        name: "frequently forwarded marker",
        body: "Häufig weitergeleitet\nOriginaltext",
        expected: { forwarded: true, displayText: "Originaltext" },
      },
      {
        name: "German edited marker",
        body: "Hallo\n<bearbeitet>",
        expected: { edited: true, displayText: "Hallo" },
      },
      {
        name: "English edited marker",
        body: "Hello <edited>",
        expected: { edited: true, displayText: "Hello" },
      },
      {
        name: "iOS bidi edited marker",
        body: "i am great \u200e<This message was edited>",
        expected: { edited: true, displayText: "i am great" },
      },
      {
        name: "quoted message",
        body: "> Mia: Alte Nachricht\n> zweite Zeile\n\nMeine Antwort",
        expected: {
          quotedText: "Mia: Alte Nachricht\nzweite Zeile",
          displayText: "Meine Antwort",
        },
      },
    ])("preserves raw text for $name", ({ body, expected }) => {
      const message = parseChat(`20.07.26, 12:10 - Ralph: ${body}`).messages[0];
      expect(message?.text).toBe(body);
      expect(message).toMatchObject(expected);
    });

    it("combines forwarded, quoted and edited metadata without changing the source body", () => {
      const body = "Forwarded\n> Original quote\n\nReply body\n<edited>";
      const message = parseChat(`20.07.26, 12:11 - Ralph: ${body}`).messages[0];
      expect(message).toMatchObject({
        text: body,
        displayText: "Reply body",
        forwarded: true,
        edited: true,
        quotedText: "Original quote",
      });
    });
  });

  describe("conservative false-positive fallbacks", () => {
    it.each([
      "Bitte öffne report.csv morgen",
      "report.pdf",
      "Im Bericht steht photo omitted als Beispiel",
      "Im Test steht <Media omitted> als Beispiel",
      "Die Umfrage: Wohin? ist noch offen",
      "The missed video call was annoying",
      "I reacted badly to that",
      "Wir treffen uns bei https://maps.google.com/?q=52.52,13.40",
      "Payment terms: due Friday",
      "Contact support for help",
      "View once video omitted ist nur ein Beispiel",
      "This message was edited by a colleague",
      "Kontakt",
      "Contact",
      "Zahlung",
      "Payment",
      "Event: Sommerfest",
      "Produkt: Sneaker ist schön",
      "Button message: klingt lustig",
      "Siehe https://example.com/article für Details",
      "Ich habe dich zur Einkaufsliste hinzugefügt",
      "I left the keys on the table",
      "I changed the group description in our document",
      "ROADMAP:\nNext release\nITEM: Feature A\nITEM: Feature B",
    ])("keeps ordinary prose as plain text: %s", (body) => {
      const message = parseChat(`20.07.26, 12:20 - Ralph: ${body}`).messages[0];
      expect(message).toMatchObject({ kind: "text", text: body });
      expect(message?.semantic).toBeUndefined();
      expect(message?.mediaReference).toBeUndefined();
      expect(message?.forwarded).toBeUndefined();
      expect(message?.edited).toBeUndefined();
    });

    it("keeps a senderless system event with a colon inside its changed subject", () => {
      const message = parseChat("7/20/26, 12:21 PM - Alice changed the subject from “A” to “B: C”", "mdy").messages[0];
      expect(message).toMatchObject({ sender: null, kind: "system" });
      expect(message?.semantic).toMatchObject({ type: "event", variant: "subject-changed" });
    });

    it("recognizes the exact German live-location export marker", () => {
      const message = parseChat("20.07.26, 12:22 - Ralph: Live-Standort wird geteilt.").messages[0];
      expect(message?.semantic).toMatchObject({ type: "location", variant: "live", title: "Live-Standort" });
    });

    it("recognizes an exported dropped pin only when a map link is present", () => {
      const body = "Dropped pin\nnear Unnamed Road\nhttps://goo.gl/maps/abc";
      const message = parseChat(`20.07.26, 12:22 - Ralph: ${body}`).messages[0];
      expect(message?.semantic).toMatchObject({ type: "location", variant: "pin", title: "Standort", body: "near Unnamed Road" });
      expect(message?.text).toBe(body);
      expect(parseChat("20.07.26, 12:22 - Ralph: Dropped pin near the door").messages[0]?.semantic).toBeUndefined();
    });

    it("recognizes a strictly named exported Foursquare venue", () => {
      const body = "\u200eBritish Library (96 Euston Rd, London, Greater London NW1 2DB): https://foursquare.com/v/4ac518cef964a52019a620e3";
      const message = parseChat(`[20.07.2026, 12:23:00] Alice: ${body}`).messages[0];
      expect(message?.semantic).toMatchObject({
        type: "location",
        variant: "venue",
        title: "Standort",
        detail: "Kartenlink",
        body: "British Library (96 Euston Rd, London, Greater London NW1 2DB)",
      });
    });

    it("does not misclassify product-shaped prose with only a status line", () => {
      const body = "Product: Roadmap\nStatus: bad";
      const message = parseChat(`20.07.26, 12:23 - Ralph: ${body}`).messages[0];
      expect(message).toMatchObject({ kind: "text", text: body });
      expect(message?.semantic).toBeUndefined();
    });
  });

  describe("strict structured and service-message markers", () => {
    it("keeps sender names that happen to be system-event keywords", () => {
      const chat = parseChat([
        "20.07.26, 12:24 - Added: Das ist mein Anzeigename",
        "20.07.26, 12:25 - Community: Ganz normale Nachricht",
      ].join("\n"));
      expect(chat.messages.map((message) => [message.sender, message.kind, message.text])).toEqual([
        ["Added", "text", "Das ist mein Anzeigename"],
        ["Community", "text", "Ganz normale Nachricht"],
      ]);
    });

    it.each([
      ["7/20/26, 12:26 PM - Alice added the group Announcements to the community", "mdy", "community-group-added"],
      ["20.07.26, 12:27 - Alice hat die Gruppe „Ankündigungen“ aus der Community entfernt", "auto", "community-group-removed"],
    ])("classifies a community subgroup event before participant changes: %s", (line, order, variant) => {
      const message = parseChat(line, order as "auto" | "mdy").messages[0];
      expect(message).toMatchObject({ sender: null, kind: "system" });
      expect(message?.semantic).toMatchObject({ type: "event", variant });
    });

    it.each([
      "Payment: due Friday",
      "Product: Roadmap\nPrice: high",
    ])("does not promote label-shaped prose without a strong payload: %s", (body) => {
      const message = parseChat(`20.07.26, 12:28 - Ralph: ${body}`).messages[0];
      expect(message).toMatchObject({ sender: "Ralph", kind: "text", text: body });
      expect(message?.semantic).toBeUndefined();
    });

    it.each([
      ["7/20/26, 12:29 PM - This chat is with a business account. Tap for more info.", "mdy", "business-notice"],
      ["20.07.26, 12:30 - Dieses Unternehmen nutzt einen sicheren Service von Meta, um diesen Chat zu verwalten.", "auto", "business-notice"],
      ["7/20/26, 12:31 PM - Alice turned on admin approval", "mdy", "join-approval-on"],
      ["20.07.26, 12:32 - Alice hat Beitrittsanfragen deaktiviert", "auto", "join-approval-off"],
      ["7/20/26, 12:33 PM - Alice changed this group's settings to allow only admins to send messages", "mdy", "group-permissions"],
      ["7/20/26, 12:33 PM - You changed this group's settings to allow all participants to add others", "mdy", "group-permissions"],
      ["7/20/26, 12:33 PM - You changed the settings so only admins can edit the group settings", "mdy", "group-permissions"],
      ["20.07.26, 12:33 - Du hast die Einstellungen so geändert, dass alle Mitglieder weitere Personen hinzufügen können", "auto", "group-permissions"],
      ["7/20/26, 12:34 PM - Alice started a group video call", "mdy", "call-started"],
      ["7/20/26, 12:35 PM - Alice updated the event Summer party", "mdy", "event-updated"],
      ["20.07.26, 12:36 - Alice hat das Ereignis Sommerfest abgesagt", "auto", "event-cancelled"],
      ["7/20/26, 12:37 PM - Alice changed your member tag to Organizer", "mdy", "member-tag-changed"],
      ["20.07.26, 12:38 - Alice hat deinen Mitglieds-Tag entfernt", "auto", "member-tag-removed"],
      ["7/20/26, 12:39 PM - Alice shared the group chat history", "mdy", "history-shared"],
    ])("recognizes the exact service marker: %s", (line, order, variant) => {
      const message = parseChat(line, order as "auto" | "mdy").messages[0];
      expect(message).toMatchObject({ sender: null, kind: "system" });
      expect(message?.semantic).toMatchObject({ type: "event", variant });
    });

    it("recognizes the exact disappearing-message notice", () => {
      const line = "7/20/26, 12:39 PM - New messages will disappear from this chat 24 hours after they're sent, except when kept. Tap to change.";
      const message = parseChat(line, "mdy").messages[0];
      expect(message).toMatchObject({ sender: null, kind: "system" });
      expect(message?.semantic).toMatchObject({ type: "event", variant: "disappearing-notice" });
    });

    it.each([
      ["Payment requested", "requested", "Zahlung angefordert"],
      ["Payment pending", "pending", "Zahlung ausstehend"],
      ["Payment canceled", "cancelled", "Zahlung storniert"],
      ["Payment expired", "expired", "Zahlungsanfrage abgelaufen"],
      ["Zahlung erstattet", "refunded", "Zahlung erstattet"],
    ])("preserves the exact payment status %s", (body, variant, title) => {
      const message = parseChat(`20.07.26, 12:39 - Ralph: ${body}`).messages[0];
      expect(message?.semantic).toMatchObject({ type: "payment", variant, title });
    });

    it("accepts whitespace between a payment currency symbol and amount", () => {
      const message = parseChat("20.07.26, 12:39 - Ralph: Payment: € 12,50").messages[0];
      expect(message?.semantic).toMatchObject({ type: "payment", variant: "sent", detail: "€ 12,50" });
    });

    it.each([
      {
        body: "Template message: order_update\nLanguage: de\nBody: Deine Bestellung ist unterwegs",
        expected: { type: "template", variant: "structured-template", title: "Nachrichtenvorlage", detail: "order_update" },
      },
      {
        body: "Flow message: Terminbuchung\nFlow ID: flow-17\nScreen: APPOINTMENT",
        expected: { type: "interactive", variant: "flow", title: "WhatsApp Flow", detail: "Terminbuchung" },
      },
      {
        body: "Flow reply: Terminbuchung\nResponse: confirmed",
        expected: { type: "interactive", variant: "flow-reply", title: "Flow-Antwort", detail: "Terminbuchung" },
      },
      {
        body: "Catalog message: Sommer\nCatalog ID: catalog-17",
        expected: { type: "business", variant: "catalog-message", title: "Katalognachricht", detail: "Sommer" },
      },
      {
        body: "Product list message: Schuhe\nCatalog ID: catalog-17\nProducts: sku-1, sku-2",
        expected: { type: "business", variant: "product-list", title: "Produktliste", detail: "Schuhe" },
      },
      {
        body: "Multi-product message: Schuhe\nCatalog ID: catalog-17\nProduct ID: sku-1",
        expected: { type: "business", variant: "product-list", title: "Produktliste", detail: "Schuhe" },
      },
      {
        body: "Product inquiry: Sneaker\nProduct ID: sku-17\nCatalog ID: catalog-17",
        expected: { type: "business", variant: "product-inquiry", title: "Produktanfrage", detail: "Sneaker" },
      },
      {
        body: "Referred product: Sneaker\nProduct ID: sku-17\nCatalog ID: catalog-17",
        expected: { type: "business", variant: "referred-product", title: "Empfohlenes Produkt", detail: "Sneaker" },
      },
      {
        body: "Referral message: Sommeraktion\nSource URL: https://example.test/ad\nCampaign ID: cmp-17",
        expected: { type: "business", variant: "referral", title: "Empfehlung", detail: "Sommeraktion" },
      },
      {
        body: "Event updated: Sommerfest\nDatum: 25.07.2026",
        expected: { type: "event", variant: "event-updated", title: "Ereignis aktualisiert", detail: "Sommerfest" },
      },
      {
        body: "Event reminder: Sommerfest",
        expected: { type: "event", variant: "event-reminder", title: "Ereigniserinnerung", detail: "Sommerfest" },
      },
      {
        body: "Location request: Treffpunkt\nButton: Share location",
        expected: { type: "interactive", variant: "location-request", title: "Standortanfrage", detail: "Treffpunkt" },
      },
      {
        body: "Address message: Lieferung\nAddress field: postal_code",
        expected: { type: "interactive", variant: "address", title: "Adressnachricht", detail: "Lieferung" },
      },
      {
        body: "CTA URL message: Website\nURL: https://example.test",
        expected: { type: "interactive", variant: "cta-url", title: "Aktionsnachricht", detail: "Website" },
      },
      {
        body: "Copy code message: Rabatt\nCode: SAVE20",
        expected: { type: "interactive", variant: "copy-code", title: "Code kopieren", detail: "Rabatt" },
      },
      {
        body: "Carousel message: Angebote\nCard 1: Sneaker",
        expected: { type: "interactive", variant: "carousel", title: "Karussellnachricht", detail: "Angebote" },
      },
    ])("recognizes an anchored rich record without guessing fields: $body", ({ body, expected }) => {
      const message = parseChat(`20.07.26, 12:40 - Ralph: ${body}`).messages[0];
      expect(message?.semantic).toMatchObject(expected);
      expect(message?.text).toBe(body);
    });

    it.each([
      ["<Template message omitted>", "template", "omitted-template"],
      ["<Flow message omitted>", "interactive", "omitted-flow"],
      ["<Flow reply omitted>", "interactive", "omitted-flow-reply"],
      ["<Product list message omitted>", "business", "omitted-product-list"],
      ["<Multi-product message omitted>", "business", "omitted-product-list"],
      ["<Product inquiry message omitted>", "business", "omitted-product-inquiry"],
      ["<Referral message omitted>", "business", "omitted-referral"],
      ["<Location request message omitted>", "interactive", "omitted-location-request"],
      ["<Address message omitted>", "interactive", "omitted-address"],
      ["<CTA URL message omitted>", "interactive", "omitted-cta-url"],
      ["<Copy code message omitted>", "interactive", "omitted-copy-code"],
      ["<Carousel message omitted>", "interactive", "omitted-carousel"],
      ["<Mystery message omitted>", "unsupported", "omitted-structured-message"],
    ])("renders the exact unavailable structured marker %s", (body, type, variant) => {
      const message = parseChat(`20.07.26, 12:41 - Ralph: ${body}`).messages[0];
      expect(message?.semantic).toMatchObject({ type, variant });
    });

    it.each([
      ["View once photo opened", "image"],
      ["View once video opened", "video"],
      ["View once voice message listened to", "audio"],
      ["Foto zur einmaligen Ansicht geöffnet", "image"],
      ["Sprachnachricht zur einmaligen Ansicht angehört", "audio"],
    ])("keeps unavailable view-once status %s as an omitted medium", (body, mediaHint) => {
      const message = parseChat(`20.07.26, 12:42 - Ralph: ${body}`).messages[0];
      expect(message).toMatchObject({ kind: "media-omitted", mediaHint });
      expect(message?.semantic).toMatchObject({ type: "view-once" });
    });

    it("shows an expired disappearing-message marker without reconstructing content", () => {
      const message = parseChat("20.07.26, 12:43 - Ralph: Selbstlöschende Nachricht abgelaufen").messages[0];
      expect(message).toMatchObject({ kind: "text", text: "Selbstlöschende Nachricht abgelaufen" });
      expect(message?.semantic).toMatchObject({ type: "unsupported", variant: "expired" });
      expect(message?.semantic?.body).toBeUndefined();
    });

    it("distinguishes frequently forwarded messages while retaining forwarded compatibility", () => {
      const messages = parseChat([
        "20.07.26, 12:44 - Ralph: Forwarded many times\nOriginal",
        "20.07.26, 12:45 - Ralph: Weitergeleitet\nOriginal",
      ].join("\n")).messages;
      expect(messages[0]).toMatchObject({ forwarded: true, frequentlyForwarded: true, displayText: "Original" });
      expect(messages[1]).toMatchObject({ forwarded: true, displayText: "Original" });
      expect(messages[1]?.frequentlyForwarded).toBeUndefined();
    });

    it("cleans bidi-only attachment lines and counts a media group as one parsed record", () => {
      const body = "Unser Album\n\u200e<attached: eins.jpg>\n\u200e<attached: zwei.mp4>";
      const chat = parseChat(`20.07.26, 12:46 - Ralph: ${body}`);
      expect(chat.messages).toHaveLength(2);
      expect(chat.messages.map((message) => message.displayText)).toEqual(["Unser Album", ""]);
      expect(chat.messages.map((message) => message.mediaReference)).toEqual(["eins.jpg", "zwei.mp4"]);
      expect(chat.diagnostics.parsedMessages).toBe(1);
    });
  });

  describe("media presentation roles", () => {
    it.each([
      ["PTT-20260720-WA0001.opus", "", "audio", "voice-note"],
      ["recording.m4a", "", "audio", "audio"],
      ["VID-1.mp4", "Video note", "video", "video-note"],
      ["GIF-20260720-WA0002.mp4", "", "video", "animated-image"],
      ["STK-20260720-WA0003.webp", "", "sticker", "sticker"],
      ["Max.vcf", "", "document", "contact"],
      ["photo.jpg", "", "image", "photo"],
      ["PTV-20260720-WA0004.mp4", "", "video", "video-note"],
    ] as const)("classifies %s as %s", (filename, marker, kind, expected) => {
      expect(mediaPresentationRole(filename, marker, kind)).toBe(expected);
    });

    it("stores the role on parsed attachment messages", () => {
      const chat = parseChat([
        "20.07.26, 11:40 - Ralph: PTT-20260720-WA0001.opus (Datei angehängt)",
        "20.07.26, 11:41 - Ralph: GIF-20260720-WA0002.mp4 (Datei angehängt)",
      ].join("\n"));
      expect(chat.messages.map((message) => message.mediaRole)).toEqual(["voice-note", "animated-image"]);
    });

    it("does not let ordinary captions change an attachment's media role", () => {
      const chat = parseChat([
        "20.07.26, 11:42 - Ralph: <attached: Urlaub.webp>\nDas ist kein Sticker",
        "20.07.26, 11:43 - Ralph: <attached: clip.mp4>\nKeine Videonotiz",
        "20.07.26, 11:44 - Ralph: <attached: voice.mp3>\nvoice message ist nur der Titel",
        "20.07.26, 11:45 - Ralph: <attached: Postkarte.webp>",
        "20.07.26, 11:46 - Ralph: <attached: STK-123.webp>",
      ].join("\n"));
      expect(chat.messages.map((message) => [message.mediaHint, message.mediaRole])).toEqual([
        ["image", "photo"],
        ["video", "video"],
        ["audio", "audio"],
        ["image", "photo"],
        ["sticker", "sticker"],
      ]);
    });

    it("uses only the omitted marker, not its caption, to choose the media role", () => {
      const message = parseChat("20.07.26, 11:47 - Ralph: image omitted\nDas ist kein Sticker").messages[0];
      expect(message).toMatchObject({ kind: "media-omitted", mediaHint: "image", mediaRole: "photo" });
    });
  });
});
