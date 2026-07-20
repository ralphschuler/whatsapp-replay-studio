import { describe, expect, it } from "vitest";
import { compileTimeline, visibleEventCount } from "../src/timeline";
import type { ChatMessage } from "../src/types";

function message(id: number, seconds: number, text = "Hallo"): ChatMessage {
  return {
    id: `m-${id}`,
    sourceOrder: id,
    timestamp: new Date(2026, 6, 20, 9, 0, seconds),
    rawTimestamp: "",
    precision: "second",
    sender: "Ralph",
    text,
    kind: "text",
    warnings: [],
  };
}

describe("timeline compiler", () => {
  it("is monotonic and deterministic", () => {
    const messages = [message(0, 0), message(1, 1), message(2, 12)];
    const first = compileTimeline(messages);
    const second = compileTimeline(messages);
    expect(first).toEqual(second);
    expect(first.events[0]!.at).toBeLessThan(first.events[1]!.at);
    expect(first.events[1]!.at).toBeLessThan(first.events[2]!.at);
  });

  it("caps long pauses in factor mode", () => {
    const messages = [message(0, 0), { ...message(1, 1), timestamp: new Date(2026, 6, 24, 9, 0, 0) }];
    const timeline = compileTimeline(messages, { mode: "factor", baseInterval: 1, maxPause: 3, speedFactor: 60, endHold: 2 });
    expect(timeline.events[1]!.at - timeline.events[0]!.at).toBeLessThanOrEqual(3.01);
  });

  it("adds reading time for long text", () => {
    const short = compileTimeline([message(0, 0), message(1, 1)], { mode: "fixed", baseInterval: 1, maxPause: 3, speedFactor: 60, endHold: 2 });
    const long = compileTimeline([message(0, 0, "x".repeat(400)), message(1, 1)], { mode: "fixed", baseInterval: 1, maxPause: 3, speedFactor: 60, endHold: 2 });
    expect(long.events[1]!.at).toBeGreaterThan(short.events[1]!.at);
  });

  it("holds a video message long enough to play a preview", () => {
    const video = message(0, 0);
    video.kind = "media";
    video.attachment = {
      archivePath: "clip.mp4",
      displayName: "clip.mp4",
      kind: "video",
      mimeType: "video/mp4",
      size: 100,
      status: "found",
    };
    const timeline = compileTimeline([video, message(1, 1)]);
    expect(timeline.events[1]!.at - timeline.events[0]!.at).toBeGreaterThan(4);
  });

  it("also holds audio and GIF messages long enough to play", () => {
    const audio = message(0, 0);
    audio.kind = "media";
    audio.attachment = {
      archivePath: "voice.opus",
      displayName: "voice.opus",
      kind: "audio",
      mimeType: "audio/opus",
      size: 100,
      status: "found",
    };
    const gif = message(1, 1);
    gif.kind = "media";
    gif.attachment = {
      archivePath: "reaction.gif",
      displayName: "reaction.gif",
      kind: "image",
      mimeType: "image/gif",
      size: 100,
      status: "found",
    };
    const timeline = compileTimeline([audio, gif, message(2, 2)]);
    expect(timeline.events[1]!.at - timeline.events[0]!.at).toBeGreaterThan(4);
    expect(timeline.events[2]!.at - timeline.events[1]!.at).toBeGreaterThan(4);
  });

  it("finds visible events with binary search", () => {
    const timeline = compileTimeline([message(0, 0), message(1, 1)]);
    expect(visibleEventCount(timeline, 0)).toBe(0);
    expect(visibleEventCount(timeline, timeline.events[0]!.at)).toBe(1);
    expect(visibleEventCount(timeline, timeline.duration + 1)).toBe(2);
  });
});
