import { describe, expect, it } from "vitest";
import { animatedFrameIndex, canvasScale, cleanMediaCaption, fitMediaBox } from "../src/renderer";
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

  it("selects animated GIF frames deterministically and loops", () => {
    const durations = [0.1, 0.2, 0.1];
    expect(animatedFrameIndex(durations, 0, 0.4)).toBe(0);
    expect(animatedFrameIndex(durations, 0.1, 0.4)).toBe(1);
    expect(animatedFrameIndex(durations, 0.3, 0.4)).toBe(2);
    expect(animatedFrameIndex(durations, 0.4, 0.4)).toBe(0);
  });
});
