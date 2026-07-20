import { MEDIA_PREVIEW_SECONDS } from "./timeline";
import type { CompiledTimeline, PcmAudioClip, ScheduledAudioAsset, ScheduledAudioClip } from "./types";
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

export function mixReplayAudioChunk(
  duration: number,
  chunkStart: number,
  dingTimes: number[],
  scheduledClips: ScheduledAudioClip[],
  sampleRate = 48_000,
): { left: Float32Array<ArrayBuffer>; right: Float32Array<ArrayBuffer> } {
  const relativeDings = dingTimes
    .filter((time) => time >= chunkStart - DING_TAIL && time < chunkStart + duration)
    .map((time) => time - chunkStart);
  const ding = synthesizeDingChannel(duration, relativeDings, sampleRate);
  const left = new Float32Array(new ArrayBuffer(ding.length * Float32Array.BYTES_PER_ELEMENT));
  const right = new Float32Array(new ArrayBuffer(ding.length * Float32Array.BYTES_PER_ELEMENT));
  left.set(ding);
  right.set(ding);

  const mixChannel = (
    destination: Float32Array<ArrayBuffer>,
    source: Float32Array<ArrayBuffer>,
    clip: PcmAudioClip,
    eventAt: number,
  ): void => {
    const chunkStartFrame = Math.round(chunkStart * sampleRate);
    const eventStartFrame = Math.round(eventAt * sampleRate);
    const eventEndFrame = eventStartFrame + Math.ceil(clip.duration * sampleRate);
    const firstOutput = Math.max(0, eventStartFrame - chunkStartFrame);
    const lastOutput = Math.min(destination.length, eventEndFrame - chunkStartFrame);
    for (let outputIndex = firstOutput; outputIndex < lastOutput; outputIndex += 1) {
      const globalFrame = chunkStartFrame + outputIndex;
      const sourcePosition = Math.max(0, (globalFrame - eventStartFrame) * clip.sampleRate / sampleRate);
      const sourceIndex = Math.floor(sourcePosition);
      if (sourceIndex >= source.length) break;
      const fraction = sourcePosition - sourceIndex;
      const first = source[sourceIndex] ?? 0;
      const second = source[Math.min(source.length - 1, sourceIndex + 1)] ?? first;
      destination[outputIndex] = (destination[outputIndex] ?? 0) + first + (second - first) * fraction;
    }
  };

  for (const scheduled of scheduledClips) {
    mixChannel(left, scheduled.clip.left, scheduled.clip, scheduled.at);
    mixChannel(right, scheduled.clip.right, scheduled.clip, scheduled.at);
  }
  for (let index = 0; index < left.length; index += 1) {
    left[index] = Math.max(-0.96, Math.min(0.96, left[index] ?? 0));
    right[index] = Math.max(-0.96, Math.min(0.96, right[index] ?? 0));
  }
  return { left, right };
}

export async function streamReplayAudio(
  source: AudioBufferSource,
  timeline: CompiledTimeline,
  selfName: string,
  scheduledAssets: ScheduledAudioAsset[],
  loadClip: (path: string) => Promise<PcmAudioClip | undefined>,
  incomingSound: boolean,
  signal?: AbortSignal,
  sampleRate = 48_000,
): Promise<void> {
  const eventTimes = incomingSound ? incomingMessageTimes(timeline, selfName) : [];
  const chunkSeconds = 5;
  for (let chunkStart = 0; chunkStart < timeline.duration; chunkStart += chunkSeconds) {
    if (signal?.aborted) throw new DOMException("Der Export wurde abgebrochen.", "AbortError");
    const duration = Math.min(chunkSeconds, timeline.duration - chunkStart);
    const scheduledClips: ScheduledAudioClip[] = [];
    for (const scheduled of scheduledAssets) {
      if (scheduled.at >= chunkStart + duration || scheduled.at + MEDIA_PREVIEW_SECONDS <= chunkStart) continue;
      const clip = await loadClip(scheduled.path);
      if (clip) scheduledClips.push({ at: scheduled.at, clip });
    }
    const channels = mixReplayAudioChunk(duration, chunkStart, eventTimes, scheduledClips, sampleRate);
    const buffer = new AudioBuffer({ numberOfChannels: 2, length: channels.left.length, sampleRate });
    buffer.copyToChannel(channels.left, 0);
    buffer.copyToChannel(channels.right, 1);
    await source.add(buffer);
  }
  source.close();
}

export class DingPlayer {
  private context: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private readonly clipBuffers = new WeakMap<PcmAudioClip, AudioBuffer>();
  private readonly activeSources = new Set<AudioBufferSourceNode>();
  private generation = 0;

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
      const generation = this.generation;
      await this.unlock();
      if (generation !== this.generation || !this.context || !this.buffer) return;
      this.startBuffer(this.buffer, 0, 0.9);
    } catch {
      // Audio can be blocked by browser autoplay policies. The replay continues silently.
    }
  }

  async playClip(clip: PcmAudioClip, offset = 0): Promise<void> {
    try {
      const generation = this.generation;
      await this.unlock();
      if (generation !== this.generation || !this.context || offset >= clip.duration) return;
      let buffer = this.clipBuffers.get(clip);
      if (!buffer) {
        buffer = this.context.createBuffer(2, clip.left.length, clip.sampleRate);
        buffer.copyToChannel(clip.left, 0);
        buffer.copyToChannel(clip.right, 1);
        this.clipBuffers.set(clip, buffer);
      }
      this.startBuffer(buffer, Math.max(0, offset), 1);
    } catch {
      // Unsupported codecs or autoplay policies should not stop the visual replay.
    }
  }

  stopAll(): void {
    this.generation += 1;
    for (const source of this.activeSources) {
      try { source.stop(); } catch { /* The source may already have ended. */ }
      source.disconnect();
    }
    this.activeSources.clear();
  }

  private startBuffer(buffer: AudioBuffer, offset: number, volume: number): void {
    if (!this.context) return;
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    source.buffer = buffer;
    gain.gain.value = volume;
    source.connect(gain);
    gain.connect(this.context.destination);
    source.onended = () => {
      this.activeSources.delete(source);
      source.disconnect();
      gain.disconnect();
    };
    this.activeSources.add(source);
    source.start(0, offset);
  }
}
