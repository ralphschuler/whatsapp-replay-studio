import type { StreamTargetChunk } from "mediabunny";

export const MEMORY_EXPORT_LIMIT_BYTES = 192 * 1024 * 1024;
export const EXPORT_STREAM_CHUNK_BYTES = 8 * 1024 * 1024;

const DEFAULT_AUDIO_BITRATE = 128_000;
const CONTAINER_OVERHEAD_FACTOR = 1.08;
const CONTAINER_ALLOWANCE_BYTES = 2 * 1024 * 1024;

export type ExportStorageStrategy = "file-system-access" | "opfs" | "memory" | "blocked";

export interface ExportStorageCapabilities {
  fileSystemAccess: boolean;
  opfs: boolean;
}

export interface ExportFileWriter {
  write(data: { type: "write"; data: Uint8Array<ArrayBuffer>; position: number }): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

export interface CommitGatedExportStream {
  stream: WritableStream<StreamTargetChunk>;
  armCommit(): void;
  discard(reason?: unknown): Promise<void>;
}

export interface ExportFileHandle {
  readonly name: string;
  createWritable(options?: { keepExistingData?: boolean }): Promise<ExportFileWriter>;
  getFile(): Promise<File>;
}

interface ExportDirectoryHandle {
  getFileHandle(name: string, options: { create: true }): Promise<ExportFileHandle>;
  removeEntry(name: string): Promise<void>;
}

interface ExportStorageManager {
  getDirectory?: () => Promise<ExportDirectoryHandle>;
  estimate?: () => Promise<{ quota?: number; usage?: number }>;
}

interface SaveFilePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<ExportFileHandle>;
}

export type PreparedExportDestination =
  | { kind: "file-system-access"; handle: ExportFileHandle }
  | { kind: "opfs"; handle: ExportFileHandle; cleanup: () => Promise<void> }
  | { kind: "memory" };

export interface PrepareExportDestinationOptions {
  estimatedBytes: number;
  suggestedName: string;
  windowObject?: Window;
  navigatorObject?: Navigator;
}

/**
 * Mediabunny closes a target both after finalization and after cancellation.
 * This gate turns a cancellation-close into an atomic file abort, so a failed
 * export never replaces the user's destination with a partial MP4.
 */
export function createCommitGatedStream(writer: ExportFileWriter): CommitGatedExportStream {
  let commitArmed = false;
  let state: "open" | "committed" | "aborted" = "open";

  const discard = async (reason: unknown = new DOMException("Der Export wurde abgebrochen.", "AbortError")): Promise<void> => {
    if (state !== "open") return;
    try {
      await writer.abort(reason);
    } finally {
      state = "aborted";
    }
  };

  const stream = new WritableStream<StreamTargetChunk>({
    write: (chunk) => writer.write(chunk),
    close: async () => {
      if (state !== "open") return;
      if (!commitArmed) {
        await discard();
        return;
      }
      try {
        await writer.close();
        state = "committed";
      } catch (error) {
        await discard(error).catch(() => undefined);
        throw error;
      }
    },
    abort: (reason) => discard(reason),
  });

  return {
    stream,
    armCommit: () => { commitArmed = true; },
    discard,
  };
}

/**
 * Estimates the encoded MP4 size from the configured bitrates. The allowance is
 * intentionally conservative: it covers container metadata and encoder spikes
 * while remaining useful for deciding whether an in-memory export is safe.
 */
export function estimateMp4SizeBytes(
  durationSeconds: number,
  videoBitrate: number,
  audioBitrate = DEFAULT_AUDIO_BITRATE,
): number {
  const duration = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0;
  const video = Number.isFinite(videoBitrate) ? Math.max(0, videoBitrate) : 0;
  const audio = Number.isFinite(audioBitrate) ? Math.max(0, audioBitrate) : 0;
  const payloadBytes = duration * (video + audio) / 8;
  return Math.ceil(payloadBytes * CONTAINER_OVERHEAD_FACTOR + CONTAINER_ALLOWANCE_BYTES);
}

export function chooseExportStorageStrategy(
  estimatedBytes: number,
  capabilities: ExportStorageCapabilities,
  memoryLimitBytes = MEMORY_EXPORT_LIMIT_BYTES,
): ExportStorageStrategy {
  if (capabilities.fileSystemAccess) return "file-system-access";
  if (capabilities.opfs) return "opfs";
  return estimatedBytes <= memoryLimitBytes ? "memory" : "blocked";
}

export function formatExportSize(bytes: number): string {
  const megabytes = Math.max(0, bytes) / 1024 / 1024;
  return `${megabytes.toLocaleString("de-DE", { maximumFractionDigits: megabytes >= 100 ? 0 : 1 })} MB`;
}

function storageError(estimatedBytes: number): Error {
  return new Error(
    `Das MP4 wird voraussichtlich etwa ${formatExportSize(estimatedBytes)} groß. `
    + "Dieser Browser kann einen so großen Export nicht speicherschonend auf die Festplatte schreiben. "
    + "Bitte verwende eine aktuelle Version von Chrome oder Edge oder verkleinere Zeitraum beziehungsweise Auflösung. "
    + "Der Export wurde zum Schutz vor einem Absturz nicht gestartet.",
  );
}

function getCapabilities(windowObject: Window, navigatorObject: Navigator): ExportStorageCapabilities {
  const pickerWindow = windowObject as Window & SaveFilePickerWindow;
  const storage = navigatorObject.storage as StorageManager & ExportStorageManager;
  return {
    fileSystemAccess: typeof pickerWindow.showSaveFilePicker === "function",
    opfs: typeof storage?.getDirectory === "function",
  };
}

async function prepareOpfsDestination(
  storage: StorageManager & ExportStorageManager,
  estimatedBytes: number,
  suggestedName: string,
): Promise<PreparedExportDestination> {
  if (storage.estimate) {
    const { quota, usage } = await storage.estimate();
    if (typeof quota === "number" && typeof usage === "number" && quota - usage < estimatedBytes * 1.1) {
      if (estimatedBytes <= MEMORY_EXPORT_LIMIT_BYTES) return { kind: "memory" };
      throw new Error(
        `Für den temporären Videoexport werden etwa ${formatExportSize(estimatedBytes)} benötigt, `
        + "im Browserspeicher ist dafür aber nicht genug Platz frei. Bitte verkleinere Zeitraum oder Auflösung.",
      );
    }
  }
  if (!storage.getDirectory) throw storageError(estimatedBytes);
  const root = await storage.getDirectory();
  const suffix = `${Date.now().toString(36)}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
  const temporaryName = `.${suggestedName.replace(/\.mp4$/iu, "")}-${suffix}.mp4`;
  const handle = await root.getFileHandle(temporaryName, { create: true });
  return {
    kind: "opfs",
    handle,
    cleanup: () => root.removeEntry(temporaryName).catch(() => undefined),
  };
}

/**
 * Invoke this directly in the export button's click handler. In particular, the
 * file picker call happens before the first await so browser user activation is
 * retained.
 */
export function prepareExportDestination(options: PrepareExportDestinationOptions): Promise<PreparedExportDestination> {
  const windowObject = options.windowObject ?? window;
  const navigatorObject = options.navigatorObject ?? navigator;
  const capabilities = getCapabilities(windowObject, navigatorObject);
  const strategy = chooseExportStorageStrategy(options.estimatedBytes, capabilities);

  if (strategy === "file-system-access") {
    const picker = (windowObject as Window & SaveFilePickerWindow).showSaveFilePicker!;
    try {
      return picker.call(windowObject, {
        suggestedName: options.suggestedName,
        types: [{ description: "MP4-Video", accept: { "video/mp4": [".mp4"] } }],
      }).then((handle) => ({ kind: "file-system-access" as const, handle }));
    } catch (error) {
      // Some embedded browsers throw synchronously when the picker is blocked.
      // Normalize that into the same handled promise path as user cancellation.
      return Promise.reject(error);
    }
  }
  if (strategy === "opfs") {
    return prepareOpfsDestination(
      navigatorObject.storage as StorageManager & ExportStorageManager,
      options.estimatedBytes,
      options.suggestedName,
    );
  }
  if (strategy === "memory") return Promise.resolve({ kind: "memory" });
  return Promise.reject(storageError(options.estimatedBytes));
}
