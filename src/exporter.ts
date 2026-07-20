import { AudioBufferSource, BufferTarget, CanvasSource, Mp4OutputFormat, Output } from "mediabunny";
import { streamReplayAudio } from "./audio";
import { AssetMediaStore, ChatCanvasRenderer } from "./renderer";
import type { CompiledTimeline, ExportPreset, ImportedProject, RenderTheme } from "./types";

export interface ExportProgress {
  phase: "prepare" | "render" | "finalize";
  progress: number;
  frame: number;
  totalFrames: number;
}

export interface ExportOptions {
  project: ImportedProject;
  timeline: CompiledTimeline;
  preset: ExportPreset;
  theme: RenderTheme;
  mediaStore: AssetMediaStore;
  incomingSound: boolean;
  fps?: number;
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
}

function abortError(): DOMException {
  return new DOMException("Der Export wurde abgebrochen.", "AbortError");
}

export async function exportReplayMp4(options: ExportOptions): Promise<Blob> {
  const fps = options.fps ?? 30;
  if (!("VideoEncoder" in window)) {
    throw new Error("Dieser Browser unterstützt keinen schnellen MP4-Export. Bitte Chrome, Edge oder Safari in einer aktuellen Version verwenden.");
  }
  options.onProgress?.({ phase: "prepare", progress: 0, frame: 0, totalFrames: 0 });
  await options.mediaStore.preloadForMessages(
    options.timeline.events.map((event) => event.message),
    (done, total) => options.onProgress?.({ phase: "prepare", progress: total ? done / total : 1, frame: done, totalFrames: total }),
  );
  if (options.signal?.aborted) throw abortError();
  const scheduledAudioAssets = options.mediaStore.getScheduledAudioAssets(options.timeline);
  const needsAudioTrack = options.incomingSound || scheduledAudioAssets.length > 0;
  if (needsAudioTrack && !("AudioEncoder" in window)) {
    throw new Error("Dieser Browser kann den Replay-Ton nicht in MP4 encodieren. Bitte einen aktuellen Chrome-, Edge- oder Safari-Browser verwenden.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = options.preset.width;
  canvas.height = options.preset.height;
  const renderer = new ChatCanvasRenderer(canvas, options.mediaStore);
  renderer.setParticipants(options.project.chat.participants);
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const source = new CanvasSource(canvas, {
    codec: "avc",
    bitrate: options.preset.bitrate,
    keyFrameInterval: 2,
    latencyMode: "quality",
  });
  output.addVideoTrack(source);
  const audioSource = needsAudioTrack
    ? new AudioBufferSource({
      codec: "aac",
      bitrate: 128_000,
      transform: { sampleRate: 48_000, numberOfChannels: 2 },
    })
    : null;
  if (audioSource) output.addAudioTrack(audioSource);
  await output.start();
  const frameDuration = 1 / fps;
  const totalFrames = Math.max(1, Math.ceil(options.timeline.duration * fps));
  let audioPromise: Promise<void> = Promise.resolve();
  let videoClosed = false;
  let exportSessionActive = false;
  const closeVideo = (): void => {
    if (!videoClosed) {
      source.close();
      videoClosed = true;
    }
  };
  try {
    await options.mediaStore.beginExportSession(options.timeline, fps);
    exportSessionActive = true;
    audioPromise = audioSource
      ? streamReplayAudio(
        audioSource,
        options.timeline,
        options.theme.selfName,
        scheduledAudioAssets,
        (path) => options.mediaStore.loadAudioClip(path),
        options.incomingSound,
        options.signal,
      )
      : Promise.resolve();
    for (let frame = 0; frame < totalFrames; frame += 1) {
      if (options.signal?.aborted) throw abortError();
      const time = frame * frameDuration;
      await renderer.prepareFrame(options.timeline, time, true);
      renderer.render(options.timeline, time, options.theme);
      await source.add(time, frameDuration, { keyFrame: frame % (fps * 2) === 0 });
      if (frame % 5 === 0 || frame === totalFrames - 1) {
        options.onProgress?.({ phase: "render", progress: (frame + 1) / totalFrames, frame: frame + 1, totalFrames });
      }
      if (frame % 30 === 0) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    closeVideo();
    await audioPromise;
    await options.mediaStore.endExportSession();
    exportSessionActive = false;
    options.onProgress?.({ phase: "finalize", progress: 0.98, frame: totalFrames, totalFrames });
    await output.finalize();
  } catch (error) {
    closeVideo();
    try { audioSource?.close(); } catch { /* It may already be closed by the streaming task. */ }
    await Promise.allSettled([audioPromise, exportSessionActive ? options.mediaStore.endExportSession() : Promise.resolve()]);
    if (output.state !== "canceled" && output.state !== "finalized") await output.cancel().catch(() => undefined);
    throw error;
  }
  if (!target.buffer) throw new Error("Der Video-Encoder hat keine Datei erzeugt.");
  options.onProgress?.({ phase: "finalize", progress: 1, frame: totalFrames, totalFrames });
  return new Blob([target.buffer], { type: "video/mp4" });
}
