import { describe, expect, it } from "vitest";
import { cleanMediaCaption } from "../src/renderer";
import type { ChatMessage } from "../src/types";

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
});
