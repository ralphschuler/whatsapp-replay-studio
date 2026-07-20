import "./style.css";
import { DingPlayer } from "./audio";
import { exportReplayMp4, type ExportProgress } from "./exporter";
import { importWhatsAppExport, reparseProject } from "./importer";
import { parseChat } from "./parser";
import { AssetMediaStore, ChatCanvasRenderer } from "./renderer";
import { compileTimeline, DEFAULT_TIMELINE_SETTINGS, formatDuration } from "./timeline";
import type {
  CompiledTimeline,
  DateOrder,
  ExportPreset,
  ImportedProject,
  RenderTheme,
  TimelineEvent,
  TimelineSettings,
  TimingMode,
} from "./types";

const PRESETS: Record<string, ExportPreset> = {
  "portrait-720": { id: "portrait-720", label: "9:16 · 720p", width: 720, height: 1280, bitrate: 4_000_000 },
  "portrait-1080": { id: "portrait-1080", label: "9:16 · 1080p", width: 1080, height: 1920, bitrate: 8_000_000 },
  "square-1080": { id: "square-1080", label: "1:1 · 1080p", width: 1080, height: 1080, bitrate: 7_000_000 },
  "landscape-1080": { id: "landscape-1080", label: "16:9 · 1080p", width: 1920, height: 1080, bitrate: 9_000_000 },
};

const DEMO_CHAT = `[18.07.26, 18:42:03] Mia: Seid ihr schon da?\n[18.07.26, 18:42:25] Ralph: Fast – noch fünf Minuten 🚲\n[18.07.26, 18:43:10] Mia: Perfekt. Ich habe draußen einen Tisch bekommen.\n[18.07.26, 18:45:02] Ralph: Super! Ist Tom auch dabei?\n[18.07.26, 18:45:41] Mia: Ja, und er hat großen Hunger 😄\n[18.07.26, 18:48:12] Ralph: Bin an der Ecke. Bis gleich!\n[18.07.26, 18:48:20] Mia: 👋`;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Bedienelement fehlt: ${id}`);
  return found as T;
}

const fileInput = element<HTMLInputElement>("file-input");
const dropZone = element<HTMLLabelElement>("drop-zone");
const importStatus = element<HTMLDivElement>("import-status");
const editor = element<HTMLDivElement>("editor");
const previewCanvas = element<HTMLCanvasElement>("preview-canvas");
const emptyPreview = element<HTMLDivElement>("empty-preview");
const dateOrderSelect = element<HTMLSelectElement>("date-order");
const selfSelect = element<HTMLSelectElement>("self-name");
const titleInput = element<HTMLInputElement>("chat-title");
const startRange = element<HTMLInputElement>("start-range");
const endRange = element<HTMLInputElement>("end-range");
const timingModeSelect = element<HTMLSelectElement>("timing-mode");
const paceSelect = element<HTMLSelectElement>("pace");
const speedFactorSelect = element<HTMLSelectElement>("speed-factor");
const factorField = element<HTMLDivElement>("factor-field");
const presetSelect = element<HTMLSelectElement>("preset");
const themeSelect = element<HTMLSelectElement>("theme");
const anonymizeInput = element<HTMLInputElement>("anonymize");
const incomingSoundInput = element<HTMLInputElement>("incoming-sound");
const playButton = element<HTMLButtonElement>("play-button");
const scrubber = element<HTMLInputElement>("scrubber");
const exportButton = element<HTMLButtonElement>("export-button");
const demoButton = element<HTMLButtonElement>("demo-button");
const renderOverlay = element<HTMLDivElement>("render-overlay");
const renderProgress = element<HTMLProgressElement>("render-progress");
const cancelExportButton = element<HTMLButtonElement>("cancel-export");
const downloadCard = element<HTMLDivElement>("download-card");
const downloadLink = element<HTMLAnchorElement>("download-link");

let project: ImportedProject | null = null;
let mediaStore: AssetMediaStore | null = null;
let renderer: ChatCanvasRenderer | null = null;
let timeline: CompiledTimeline = { events: [], duration: 0 };
let currentTime = 0;
let playing = false;
let playbackStartedAt = 0;
let playbackStartTime = 0;
let animationFrame = 0;
let exportController: AbortController | null = null;
let downloadUrl = "";
let preparingPreview = false;
let pendingPreviewRequest: { renderer: ChatCanvasRenderer; timeline: CompiledTimeline; time: number } | null = null;
let mediaPreparationGeneration = 0;
let mediaReady = false;
let baseDiagnostics = "";
let previousPlaybackTime = 0;
let playbackGeneration = 0;
const playedAudioEvents = new Set<string>();
const audioPlayer = new DingPlayer();

function currentPreset(): ExportPreset {
  return PRESETS[presetSelect.value] ?? PRESETS["portrait-720"]!;
}

function currentTheme(): RenderTheme {
  return {
    mode: themeSelect.value === "light" ? "light" : "dark",
    title: titleInput.value.trim() || "WhatsApp Replay",
    selfName: selfSelect.value,
    anonymize: anonymizeInput.checked,
  };
}

function currentTimelineSettings(): TimelineSettings {
  return {
    ...DEFAULT_TIMELINE_SETTINGS,
    mode: timingModeSelect.value as TimingMode,
    baseInterval: Number(paceSelect.value),
    speedFactor: Number(speedFactorSelect.value),
  };
}

function selectedMessages() {
  if (!project) return [];
  const groups = logicalMessageGroups(project.chat.messages);
  const startGroup = groups[Number(startRange.value)];
  const endGroup = groups[Number(endRange.value)];
  if (!startGroup || !endGroup) return [];
  return project.chat.messages.slice(startGroup.startIndex, endGroup.endIndex + 1);
}

function logicalMessageGroups(messages: ImportedProject["chat"]["messages"]): Array<{ startIndex: number; endIndex: number }> {
  const groups: Array<{ key: string; startIndex: number; endIndex: number }> = [];
  messages.forEach((message, index) => {
    const key = message.logicalMessageId ?? message.id;
    const previous = groups.at(-1);
    if (previous?.key === key) previous.endIndex = index;
    else groups.push({ key, startIndex: index, endIndex: index });
  });
  return groups;
}

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function setText(id: string, value: string): void {
  element<HTMLElement>(id).textContent = value;
}

function setStatus(message: string, type: "info" | "error" | "success" = "info"): void {
  importStatus.textContent = message;
  importStatus.dataset.type = type;
}

function setExportBusy(busy: boolean): void {
  const controls: Array<HTMLInputElement | HTMLSelectElement | HTMLButtonElement> = [
    fileInput,
    dateOrderSelect,
    selfSelect,
    titleInput,
    startRange,
    endRange,
    timingModeSelect,
    paceSelect,
    speedFactorSelect,
    presetSelect,
    themeSelect,
    anonymizeInput,
    incomingSoundInput,
    playButton,
    scrubber,
    exportButton,
    demoButton,
  ];
  for (const control of controls) control.disabled = busy;
  if (!busy) {
    playButton.disabled = !project || !mediaReady;
    scrubber.disabled = !project;
    exportButton.disabled = !project || !mediaReady;
  }
  dropZone.classList.toggle("is-disabled", busy);
  dropZone.setAttribute("aria-disabled", String(busy));
}

function sanitizeTitle(filename: string): string {
  return filename.replace(/\.(?:zip|txt)$/iu, "").replace(/^_?chat(?: with| mit)?\s*/iu, "").replace(/[_-]+/gu, " ").trim() || "WhatsApp Replay";
}

function applyCanvasPreset(): void {
  const preset = currentPreset();
  previewCanvas.width = preset.width;
  previewCanvas.height = preset.height;
  previewCanvas.dataset.orientation = preset.width > preset.height ? "landscape" : preset.width === preset.height ? "square" : "portrait";
  setText("preview-resolution", `${preset.width} × ${preset.height}`);
  if (mediaStore) {
    renderer = new ChatCanvasRenderer(previewCanvas, mediaStore);
    renderer.setParticipants(project?.chat.participants ?? []);
  }
  redraw();
}

function updateRangeLabels(): void {
  if (!project) return;
  const startIndex = Number(startRange.value);
  const endIndex = Number(endRange.value);
  const groups = logicalMessageGroups(project.chat.messages);
  const startMessage = project.chat.messages[groups[startIndex]?.startIndex ?? -1];
  const endMessage = project.chat.messages[groups[endIndex]?.endIndex ?? -1];
  setText("start-label", startMessage ? `${startIndex + 1} · ${formatDateTime(startMessage.timestamp)}` : "–");
  setText("end-label", endMessage ? `${endIndex + 1} · ${formatDateTime(endMessage.timestamp)}` : "–");
}

function updateTimeline(resetPosition = false, preserveAbsoluteTime = false): void {
  if (playing) stopPlayback();
  const previousTime = currentTime;
  const previousRatio = timeline.duration ? currentTime / timeline.duration : 0;
  timeline = compileTimeline(
    selectedMessages(),
    currentTimelineSettings(),
    mediaStore?.getKnownMediaDurations() ?? new Map(),
  );
  currentTime = resetPosition
    ? 0
    : Math.min(timeline.duration, preserveAbsoluteTime ? previousTime : previousRatio * timeline.duration);
  scrubber.max = String(Math.max(0.01, timeline.duration));
  scrubber.value = String(currentTime);
  setText("duration-label", formatDuration(timeline.duration));
  setText("total-time", formatDuration(timeline.duration));
  factorField.hidden = timingModeSelect.value !== "factor";
  updateRangeLabels();
  redraw();
}

async function flushPreviewRequests(): Promise<void> {
  if (preparingPreview) return;
  preparingPreview = true;
  try {
    while (pendingPreviewRequest) {
      const request = pendingPreviewRequest;
      pendingPreviewRequest = null;
      await request.renderer.prepareFrame(request.timeline, request.time);
      if (renderer === request.renderer && timeline === request.timeline) {
        request.renderer.render(request.timeline, currentTime, currentTheme());
      }
    }
  } finally {
    preparingPreview = false;
  }
}

function redraw(): void {
  if (!renderer || !timeline.events.length) return;
  renderer.render(timeline, currentTime, currentTheme());
  setText("current-time", formatDuration(currentTime));
  scrubber.value = String(currentTime);
  pendingPreviewRequest = { renderer, timeline, time: currentTime };
  void flushPreviewRequests();
}

function stopPlayback(): void {
  playing = false;
  playbackGeneration += 1;
  cancelAnimationFrame(animationFrame);
  audioPlayer.stopAll();
  playButton.textContent = "▶";
  playButton.setAttribute("aria-label", "Vorschau abspielen");
}

async function playAttachedAudio(event: TimelineEvent, generation: number): Promise<void> {
  const attachment = event.message.attachment;
  const activeStore = mediaStore;
  if (!activeStore || attachment?.status !== "found" || !["audio", "video"].includes(attachment.kind)) return;
  const timing = activeStore.getAudioTiming(attachment.archivePath);
  if (!timing) return;
  if (!playing || generation !== playbackGeneration || mediaStore !== activeStore) return;
  const offset = currentTime - (event.at + timing.startOffset);
  const eventKey = `${event.message.id}@${event.at}`;
  if (offset < timing.duration && !playedAudioEvents.has(eventKey)) {
    playedAudioEvents.add(eventKey);
    void audioPlayer.playStream(
      attachment.archivePath,
      timing.duration,
      offset,
      (path, start, segmentDuration) => activeStore.loadAudioSegment(path, start, segmentDuration),
    );
  }
}

function playbackFrame(now: number): void {
  if (!playing) return;
  const before = currentTime;
  currentTime = playbackStartTime + (now - playbackStartedAt) / 1000;
  if (currentTime >= timeline.duration) {
    currentTime = timeline.duration;
    stopPlayback();
  } else {
    animationFrame = requestAnimationFrame(playbackFrame);
  }
  if (playing && currentTime > before) {
    const generation = playbackGeneration;
    const crossedEvents = timeline.events.filter((event) =>
      event.at > Math.max(before, previousPlaybackTime) && event.at <= currentTime,
    );
    const hasIncoming = crossedEvents.some((event) =>
      Boolean(event.message.sender)
      && event.message.sender !== selfSelect.value
      && (event.message.attachmentGroup?.index ?? 0) === 0,
    );
    if (incomingSoundInput.checked && hasIncoming) void audioPlayer.play();
    for (const event of crossedEvents) {
      if (["audio", "video"].includes(event.message.attachment?.kind ?? "")) void playAttachedAudio(event, generation);
    }
  }
  previousPlaybackTime = currentTime;
  redraw();
}

function logicalMessageCount(messages: ImportedProject["chat"]["messages"]): number {
  return logicalMessageGroups(messages).length;
}

function togglePlayback(): void {
  if (!timeline.events.length) return;
  if (playing) {
    stopPlayback();
    return;
  }
  if (currentTime >= timeline.duration) currentTime = 0;
  playing = true;
  playbackGeneration += 1;
  playedAudioEvents.clear();
  const generation = playbackGeneration;
  previousPlaybackTime = currentTime;
  playbackStartTime = currentTime;
  playbackStartedAt = performance.now();
  playButton.textContent = "❚❚";
  playButton.setAttribute("aria-label", "Vorschau pausieren");
  void audioPlayer.unlock();
  for (const event of timeline.events) {
    const duration = event.mediaDuration ?? (event.message.attachment
      ? mediaStore?.getPlaybackDuration(event.message.attachment.archivePath)
      : undefined);
    if (
      event.at > currentTime ||
      !duration ||
      currentTime - event.at >= duration ||
      !["audio", "video"].includes(event.message.attachment?.kind ?? "")
    ) continue;
    void playAttachedAudio(event, generation);
  }
  animationFrame = requestAnimationFrame(playbackFrame);
}

async function prepareMediaForPreview(): Promise<void> {
  const activeStore = mediaStore;
  const activeProject = project;
  if (!activeStore || !activeProject || !timeline.events.length) return;
  const generation = ++mediaPreparationGeneration;
  await activeStore.preloadForMessages(activeProject.chat.messages);
  if (generation !== mediaPreparationGeneration || mediaStore !== activeStore || project !== activeProject) return;
  updateTimeline(false, true);
  const mediaIssues = activeStore.getMediaIssues(activeProject.chat.messages);
  const diagnostic = element<HTMLDivElement>("diagnostic");
  diagnostic.textContent = [baseDiagnostics, ...mediaIssues].filter(Boolean).join(" ");
  diagnostic.hidden = !diagnostic.textContent;
  mediaReady = true;
  setExportBusy(false);
  setStatus(
    mediaIssues.length
      ? `${logicalMessageCount(activeProject.chat.messages).toLocaleString("de-DE")} Nachrichten sind bereit; ${mediaIssues.length} Medienhinweis${mediaIssues.length === 1 ? "" : "e"}.`
      : `${logicalMessageCount(activeProject.chat.messages).toLocaleString("de-DE")} Nachrichten und Medienlängen sind bereit.`,
    mediaIssues.length ? "info" : "success",
  );
  redraw();
}

function populateProject(nextProject: ImportedProject, keepTitle = false): void {
  stopPlayback();
  mediaPreparationGeneration += 1;
  mediaReady = false;
  project = nextProject;
  setExportBusy(false);
  mediaStore?.dispose();
  mediaStore = new AssetMediaStore(project);
  renderer = new ChatCanvasRenderer(previewCanvas, mediaStore);
  renderer.setParticipants(project.chat.participants);
  emptyPreview.hidden = true;
  editor.hidden = false;
  scrubber.disabled = false;
  setText("file-name", project.filename);
  setText("chat-file-name", project.chatFilename);
  setText("stat-messages", logicalMessageCount(project.chat.messages).toLocaleString("de-DE"));
  setText("stat-participants", String(project.chat.participants.length));
  setText("stat-media", String(project.attachmentStats.matched));
  if (!keepTitle) titleInput.value = sanitizeTitle(project.filename);

  selfSelect.replaceChildren();
  for (const participant of project.chat.participants) {
    const option = document.createElement("option");
    option.value = participant;
    option.textContent = participant;
    selfSelect.append(option);
  }

  const max = Math.max(0, logicalMessageCount(project.chat.messages) - 1);
  startRange.max = String(max);
  endRange.max = String(max);
  startRange.value = "0";
  endRange.value = String(max);
  const warnings = [...project.chat.diagnostics.warnings];
  if (project.attachmentStats.missing) warnings.push(`${project.attachmentStats.missing} referenzierte Medien wurden nicht gefunden.`);
  if (project.attachmentStats.ambiguous) warnings.push(`${project.attachmentStats.ambiguous} Mediennamen sind mehrfach vorhanden.`);
  const diagnostic = element<HTMLDivElement>("diagnostic");
  baseDiagnostics = warnings.join(" ");
  diagnostic.hidden = !baseDiagnostics;
  diagnostic.textContent = baseDiagnostics;
  dateOrderSelect.value = project.chat.diagnostics.dateOrderAmbiguous ? "auto" : project.chat.diagnostics.dateOrder;
  applyCanvasPreset();
  updateTimeline(true);
  setStatus(`${logicalMessageCount(project.chat.messages).toLocaleString("de-DE")} Nachrichten importiert; Medienlängen werden gelesen …`);
  void prepareMediaForPreview();
}

async function handleFile(file: File): Promise<void> {
  stopPlayback();
  downloadCard.hidden = true;
  setStatus("ZIP wird geprüft und der Chat wird gelesen …");
  dropZone.classList.add("is-loading");
  try {
    const imported = await importWhatsAppExport(file, dateOrderSelect.value as DateOrder);
    populateProject(imported);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Der Import ist fehlgeschlagen.";
    setStatus(message, "error");
  } finally {
    dropZone.classList.remove("is-loading");
    fileInput.value = "";
  }
}

function loadDemo(): void {
  const chat = parseChat(DEMO_CHAT, "dmy");
  const demo: ImportedProject = {
    filename: "Beispiel-Chat.zip",
    chatFilename: "_chat.txt",
    chatText: DEMO_CHAT,
    chat,
    assets: [],
    attachmentStats: { matched: 0, missing: 0, ambiguous: 0, unreferenced: 0 },
  };
  titleInput.value = "Abend mit Freunden";
  populateProject(demo, true);
}

function handleExportProgress(progress: ExportProgress): void {
  const percent = Math.round(progress.progress * 100);
  renderProgress.value = percent;
  setText("render-percent", `${percent} %`);
  if (progress.phase === "prepare") setText("render-detail", "Medien werden vorbereitet …");
  else if (progress.phase === "render") setText("render-detail", `Frame ${progress.frame.toLocaleString("de-DE")} von ${progress.totalFrames.toLocaleString("de-DE")}`);
  else setText("render-detail", "MP4 wird finalisiert …");
}

async function startExport(): Promise<void> {
  if (!project || !mediaStore || !timeline.events.length) return;
  stopPlayback();
  exportController = new AbortController();
  setExportBusy(true);
  renderOverlay.hidden = false;
  downloadCard.hidden = true;
  renderProgress.value = 0;
  setText("render-percent", "0 %");
  setText("render-title", "Video wird erstellt");
  setText("render-detail", "Medienlängen werden gelesen …");
  try {
    const activeStore = mediaStore;
    const activeProject = project;
    await activeStore.preloadForMessages(selectedMessages(), (done, total) => {
      const progress = total ? done / total : 1;
      handleExportProgress({ phase: "prepare", progress: progress * 0.08, frame: done, totalFrames: total });
    });
    if (mediaStore !== activeStore || project !== activeProject) throw new Error("Das Projekt wurde während der Vorbereitung gewechselt.");
    updateTimeline(false, true);
    const blob = await exportReplayMp4({
      project: activeProject,
      timeline,
      preset: currentPreset(),
      theme: currentTheme(),
      mediaStore: activeStore,
      incomingSound: incomingSoundInput.checked,
      signal: exportController.signal,
      onProgress: handleExportProgress,
    });
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(blob);
    downloadLink.href = downloadUrl;
    const safeTitle = currentTheme().title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/gu, "").toLowerCase() || "chat-replay";
    downloadLink.download = `${safeTitle}.mp4`;
    setText("download-meta", `${currentPreset().label} · ${formatDuration(timeline.duration)} · ${(blob.size / 1024 / 1024).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB`);
    downloadCard.hidden = false;
    setText("render-title", "Fertig");
    setText("render-detail", "Das MP4 kann jetzt heruntergeladen werden.");
    await new Promise((resolve) => setTimeout(resolve, 450));
    renderOverlay.hidden = true;
  } catch (error) {
    renderOverlay.hidden = true;
    if (error instanceof DOMException && error.name === "AbortError") {
      setStatus("Der Videoexport wurde abgebrochen.", "info");
    } else {
      const message = error instanceof Error ? error.message : "Der Videoexport ist fehlgeschlagen.";
      setStatus(message, "error");
    }
  } finally {
    exportController = null;
    setExportBusy(false);
  }
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void handleFile(file);
});
dropZone.addEventListener("dragover", (event) => { event.preventDefault(); dropZone.classList.add("is-dragging"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-dragging"));
dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("is-dragging");
  const file = event.dataTransfer?.files[0];
  if (file) void handleFile(file);
});
demoButton.addEventListener("click", loadDemo);
dateOrderSelect.addEventListener("change", () => {
  if (!project) return;
  const reparsed = reparseProject(project, dateOrderSelect.value as DateOrder);
  populateProject(reparsed, true);
});
startRange.addEventListener("input", () => {
  if (Number(startRange.value) > Number(endRange.value)) endRange.value = startRange.value;
  updateTimeline(true);
});
endRange.addEventListener("input", () => {
  if (Number(endRange.value) < Number(startRange.value)) startRange.value = endRange.value;
  updateTimeline(true);
});
[timingModeSelect, paceSelect, speedFactorSelect].forEach((control) => control.addEventListener("change", () => updateTimeline()));
[selfSelect, titleInput, themeSelect, anonymizeInput].forEach((control) => control.addEventListener("input", redraw));
presetSelect.addEventListener("change", applyCanvasPreset);
playButton.addEventListener("click", togglePlayback);
scrubber.addEventListener("input", () => { stopPlayback(); currentTime = Number(scrubber.value); redraw(); });
exportButton.addEventListener("click", () => void startExport());
cancelExportButton.addEventListener("click", () => exportController?.abort());

applyCanvasPreset();
setExportBusy(false);
