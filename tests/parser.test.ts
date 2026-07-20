import { describe, expect, it } from "vitest";
import { parseChat, readHeader } from "../src/parser";

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

  it("does not classify ordinary angle-bracket text as media", () => {
    const chat = parseChat("[17.07.26, 09:57:57] Ralph: <Hinweis: report.xyz>");
    expect(chat.messages[0]?.kind).toBe("text");
    expect(chat.messages[0]?.mediaReference).toBeUndefined();
  });

  it("does not treat log timestamps as WhatsApp headers", () => {
    const chat = parseChat("20.07.26, 09:03 - Ralph: Log:\n2016-04-29 10:30:00\nhttps://x.test:443/a");
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0]?.text).toContain("2016-04-29 10:30:00");
    expect(chat.messages[0]?.text).toContain("https://x.test:443/a");
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
});
