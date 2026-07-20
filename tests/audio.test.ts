import { describe, expect, it } from "vitest";
import { incomingMessageTimes, mixReplayAudioChunk, synthesizeDingChannel } from "../src/audio";
import { compileTimeline } from "../src/timeline";
import type { ChatMessage, PcmAudioClip } from "../src/types";

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

  it("mixes attached audio at its timeline position", () => {
    const samples = new Float32Array(new ArrayBuffer(4 * Float32Array.BYTES_PER_ELEMENT));
    samples.set([0.1, 0.2, 0.3, 0.4]);
    const clip: PcmAudioClip = {
      duration: 0.5,
      sampleRate: 8,
      left: samples,
      right: samples.slice() as Float32Array<ArrayBuffer>,
      peaks: [],
    };
    const mixed = mixReplayAudioChunk(2, 0, [], [{ at: 1, clip }], 8);
    expect([...mixed.left.slice(0, 8)]).toEqual(new Array(8).fill(0));
    expect([...mixed.left.slice(8, 12)]).toEqual([
      expect.closeTo(0.1, 6),
      expect.closeTo(0.2, 6),
      expect.closeTo(0.3, 6),
      expect.closeTo(0.4, 6),
    ]);
  });
});
