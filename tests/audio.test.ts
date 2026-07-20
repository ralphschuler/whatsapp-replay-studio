import { describe, expect, it, vi } from "vitest";
import {
  audioSegmentForChunk,
  incomingMessageTimes,
  mixReplayAudioChunk,
  scheduleDecodedAudioSegment,
  streamReplayAudio,
  synthesizeDingChannel,
} from "../src/audio";
import { SELF_NOT_IN_EXPORT } from "../src/identity";
import { compileTimeline } from "../src/timeline";
import type { AudioBufferSource } from "mediabunny";
import type { ChatMessage, CompiledTimeline, PcmAudioClip } from "../src/types";

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
    expect(incomingMessageTimes(timeline, "")).toEqual([]);
    expect(incomingMessageTimes(timeline, SELF_NOT_IN_EXPORT)).toEqual(timeline.events.map((event) => event.at));
  });

  it("schedules one incoming sound for one logical multi-attachment message", () => {
    const group = [0, 1, 2].map((index) => ({
      ...message(index, "Mia"),
      id: `album-${index}`,
      logicalMessageId: "album",
      attachmentGroup: { id: "album", index, size: 3, kind: "explicit-multi" as const },
    }));
    const standalone = message(3, "Mia");
    const timeline = compileTimeline([...group, standalone]);

    expect(incomingMessageTimes(timeline, "Ralph")).toEqual([
      timeline.events[0]!.at,
      timeline.events[3]!.at,
    ]);
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

  it("requests every overlapping portion of a long audio asset", () => {
    const scheduled = { at: 4.8, path: "voice.opus", duration: 12.3, clipStart: 0, required: true };
    expect(audioSegmentForChunk(scheduled, 0, 5)).toEqual({ clipStart: 0, duration: expect.closeTo(0.2, 8), at: 4.8 });
    expect(audioSegmentForChunk(scheduled, 5, 5)).toEqual({ clipStart: expect.closeTo(0.2, 8), duration: 5, at: 5 });
    expect(audioSegmentForChunk(scheduled, 10, 5)).toEqual({ clipStart: expect.closeTo(5.2, 8), duration: 5, at: 10 });
    expect(audioSegmentForChunk(scheduled, 15, 5)).toEqual({ clipStart: expect.closeTo(10.2, 8), duration: expect.closeTo(2.1, 8), at: 15 });
    expect(audioSegmentForChunk(scheduled, 20, 5)).toBeUndefined();
    expect(audioSegmentForChunk({ ...scheduled, at: 5, clipStart: 0.2 }, 5, 5)?.clipStart).toBeCloseTo(0.2, 8);
  });

  it("keeps decoded audio on the replay clock instead of delaying it", () => {
    expect(scheduleDecodedAudioSegment(10, 0, 10.6, 8)).toEqual({
      when: expect.closeTo(10.62, 8),
      offset: expect.closeTo(0.62, 8),
    });
    expect(scheduleDecodedAudioSegment(10, 8, 15, 8)).toEqual({ when: 18, offset: 0 });
    expect(scheduleDecodedAudioSegment(10, 0, 19, 8)).toBeUndefined();
  });

  it("streams a long audio attachment through every export chunk", async () => {
    class FakeAudioBuffer {
      readonly numberOfChannels: number;
      readonly length: number;
      readonly sampleRate: number;
      readonly duration: number;
      private readonly channels: Float32Array[];

      constructor(options: { numberOfChannels: number; length: number; sampleRate: number }) {
        this.numberOfChannels = options.numberOfChannels;
        this.length = options.length;
        this.sampleRate = options.sampleRate;
        this.duration = options.length / options.sampleRate;
        this.channels = Array.from({ length: options.numberOfChannels }, () => new Float32Array(options.length));
      }

      copyToChannel(source: Float32Array, channel: number): void {
        this.channels[channel]?.set(source);
      }

      getChannelData(channel: number): Float32Array {
        return this.channels[channel] ?? new Float32Array();
      }
    }

    vi.stubGlobal("AudioBuffer", FakeAudioBuffer);
    const requests: Array<{ start: number; duration: number }> = [];
    const buffers: AudioBuffer[] = [];
    const source = {
      add: vi.fn(async (buffer: AudioBuffer) => { buffers.push(buffer); }),
      close: vi.fn(),
    } as unknown as AudioBufferSource;
    const timeline: CompiledTimeline = { events: [], duration: 15 };
    try {
      await streamReplayAudio(
        source,
        timeline,
        "Ich",
        [{ at: 0, path: "voice.opus", duration: 12.3, clipStart: 0, required: true }],
        async (_path, start, duration) => {
          requests.push({ start, duration });
          const length = Math.ceil(duration * 10);
          return {
            duration,
            sampleRate: 10,
            left: new Float32Array(length).fill(0.2) as Float32Array<ArrayBuffer>,
            right: new Float32Array(length).fill(0.2) as Float32Array<ArrayBuffer>,
            peaks: [],
          };
        },
        false,
        undefined,
        10,
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(requests.map((request) => request.start)).toEqual([0, 5, 10]);
    expect(requests.map((request) => request.duration)).toEqual([
      5,
      5,
      expect.closeTo(2.3, 8),
    ]);
    expect(buffers).toHaveLength(3);
    expect(source.close).toHaveBeenCalledOnce();
  });
});
