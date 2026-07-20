import { describe, expect, it } from "vitest";
import { incomingMessageTimes, synthesizeDingChannel } from "../src/audio";
import { compileTimeline } from "../src/timeline";
import type { ChatMessage } from "../src/types";

function message(id: number, sender: string): ChatMessage {
  return {
    id: `m-${id}`,
    sourceOrder: id,
    timestamp: new Date(2026, 6, 20, 9, 0, id),
    rawTimestamp: "",
    precision: "second",
    sender,
    text: "Hallo",
    kind: "text",
    warnings: [],
  };
}

describe("incoming ding", () => {
  it("only schedules sounds for incoming messages", () => {
    const timeline = compileTimeline([message(0, "Ralph"), message(1, "Mia"), message(2, "Ralph"), message(3, "Mia")]);
    expect(incomingMessageTimes(timeline, "Ralph")).toEqual([timeline.events[1]!.at, timeline.events[3]!.at]);
  });

  it("creates a bounded audible waveform", () => {
    const channel = synthesizeDingChannel(1, [0.1], 8_000);
    const peak = channel.reduce((maximum, sample) => Math.max(maximum, Math.abs(sample)), 0);
    expect(channel).toHaveLength(8_000);
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThanOrEqual(0.72);
  });

  it("preserves a ding across streamed audio chunk boundaries", () => {
    const full = synthesizeDingChannel(10, [4.5, 4.9], 8_000);
    const first = synthesizeDingChannel(5, [4.5, 4.9], 8_000);
    const second = synthesizeDingChannel(5, [-0.5, -0.1], 8_000);
    const joined = new Float32Array(full.length);
    joined.set(first);
    joined.set(second, first.length);

    let maxDifference = 0;
    for (let index = 0; index < full.length; index += 1) {
      maxDifference = Math.max(maxDifference, Math.abs(joined[index]! - full[index]!));
    }

    expect(maxDifference).toBeLessThan(1e-6);
  });
});
