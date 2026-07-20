import type { CompiledTimeline } from "./types";
import type { AudioBufferSource } from "mediabunny";

const DING_DURATION = 0.46;
const DING_SECOND_TONE_OFFSET = 0.105;
const DING_TAIL = DING_DURATION + DING_SECOND_TONE_OFFSET;

export function incomingMessageTimes(timeline: CompiledTimeline, selfName: string): number[] {
  return timeline.events
    .filter((event) => Boolean(event.message.sender) && event.message.sender !== selfName)
    .map((event) => event.at);
}

export function synthesizeDingChannel(
  duration: number,
  eventTimes: number[],
  sampleRate: number,
): Float32Array<ArrayBuffer> {
  const length = Math.max(1, Math.ceil(duration * sampleRate));
  const output = new Float32Array(new ArrayBuffer(length * Float32Array.BYTES_PER_ELEMENT));
  const addBell = (startTime: number, frequency: number, amplitude: number, offset: number): void => {
    // Round to the nearest sample so chunked synthesis uses the exact same
    // sample positions as a single full-length render. Floating-point
    // representations such as 4.9 and -0.1 can otherwise differ by one
    // sample at chunk boundaries.
    const rawStart = Math.round((startTime + offset) * sampleRate);
    const sourceStart = Math.max(0, -rawStart);
    const bellLength = Math.floor(DING_DURATION * sampleRate);
    for (let index = sourceStart; index < bellLength && rawStart + index < output.length; index += 1) {
      const t = index / sampleRate;
      const attack = Math.min(1, t / 0.008);
      const envelope = attack * Math.exp(-8.7 * t);
      const fundamental = Math.sin(2 * Math.PI * frequency * t);
      const overtone = 0.28 * Math.sin(2 * Math.PI * frequency * 2.01 * t);
      const outputIndex = rawStart + index;
      if (outputIndex >= 0) output[outputIndex] = (output[outputIndex] ?? 0) + amplitude * envelope * (fundamental + overtone);
    }
  };

  for (const time of eventTimes) {
    addBell(time, 880, 0.18, 0);
    addBell(time, 1318.51, 0.15, DING_SECOND_TONE_OFFSET);
  }
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Math.max(-0.72, Math.min(0.72, output[index] ?? 0));
  }
  return output;
}

export function createDingAudioBuffer(
  timeline: CompiledTimeline,
  selfName: string,
  sampleRate = 48_000,
): AudioBuffer {
  const times = incomingMessageTimes(timeline, selfName);
  const channel = synthesizeDingChannel(timeline.duration, times, sampleRate);
  const audioBuffer = new AudioBuffer({ numberOfChannels: 2, length: channel.length, sampleRate });
  audioBuffer.copyToChannel(channel, 0);
  audioBuffer.copyToChannel(channel, 1);
  return audioBuffer;
}

export async function streamDingAudio(
  source: AudioBufferSource,
  timeline: CompiledTimeline,
  selfName: string,
  signal?: AbortSignal,
  sampleRate = 48_000,
): Promise<void> {
  const eventTimes = incomingMessageTimes(timeline, selfName);
  const chunkSeconds = 5;
  for (let chunkStart = 0; chunkStart < timeline.duration; chunkStart += chunkSeconds) {
    if (signal?.aborted) throw new DOMException("Der Export wurde abgebrochen.", "AbortError");
    const duration = Math.min(chunkSeconds, timeline.duration - chunkStart);
    const relativeTimes = eventTimes
      .filter((time) => time >= chunkStart - DING_TAIL && time < chunkStart + duration)
      .map((time) => time - chunkStart);
    const channel = synthesizeDingChannel(duration, relativeTimes, sampleRate);
    const buffer = new AudioBuffer({ numberOfChannels: 2, length: channel.length, sampleRate });
    buffer.copyToChannel(channel, 0);
    buffer.copyToChannel(channel, 1);
    await source.add(buffer);
  }
  source.close();
}

export class DingPlayer {
  private context: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;

  async unlock(): Promise<void> {
    this.context ??= new AudioContext();
    if (this.context.state === "suspended") await this.context.resume();
    if (!this.buffer) {
      const channel = synthesizeDingChannel(DING_TAIL + 0.02, [0], this.context.sampleRate);
      this.buffer = this.context.createBuffer(1, channel.length, this.context.sampleRate);
      this.buffer.copyToChannel(channel, 0);
    }
  }

  async play(): Promise<void> {
    try {
      await this.unlock();
      if (!this.context || !this.buffer) return;
      const source = this.context.createBufferSource();
      const gain = this.context.createGain();
      source.buffer = this.buffer;
      gain.gain.value = 0.9;
      source.connect(gain);
      gain.connect(this.context.destination);
      source.start();
    } catch {
      // Audio can be blocked by browser autoplay policies. The replay continues silently.
    }
  }
}
