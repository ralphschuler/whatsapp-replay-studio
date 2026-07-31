import { describe, expect, it } from "vitest";
import {
  chooseExportStorageStrategy,
  createCommitGatedStream,
  estimateMp4SizeBytes,
  MEMORY_EXPORT_LIMIT_BYTES,
  prepareExportDestination,
  type ExportFileHandle,
  type ExportFileWriter,
} from "../src/export-destination";

describe("export destination planning", () => {
  it("estimates long exports from video and audio bitrates", () => {
    const estimated = estimateMp4SizeBytes(35 * 60, 4_000_000, 128_000);
    expect(estimated).toBeGreaterThan(1_000_000_000);
    expect(estimated).toBeLessThan(1_300_000_000);
  });

  it("prefers a user-selected file over every fallback", () => {
    expect(chooseExportStorageStrategy(2_000_000_000, {
      fileSystemAccess: true,
      opfs: true,
    })).toBe("file-system-access");
  });

  it("uses OPFS for a large export when the file picker is unavailable", () => {
    expect(chooseExportStorageStrategy(2_000_000_000, {
      fileSystemAccess: false,
      opfs: true,
    })).toBe("opfs");
  });

  it("allows a bounded in-memory fallback", () => {
    expect(chooseExportStorageStrategy(MEMORY_EXPORT_LIMIT_BYTES, {
      fileSystemAccess: false,
      opfs: false,
    })).toBe("memory");
  });

  it("blocks an unsafe in-memory export", () => {
    expect(chooseExportStorageStrategy(MEMORY_EXPORT_LIMIT_BYTES + 1, {
      fileSystemAccess: false,
      opfs: false,
    })).toBe("blocked");
  });

  it("aborts a partial file when Mediabunny closes a canceled target", async () => {
    const calls: string[] = [];
    const writer: ExportFileWriter = {
      write: async () => { calls.push("write"); },
      close: async () => { calls.push("close"); },
      abort: async () => { calls.push("abort"); },
    };
    const gated = createCommitGatedStream(writer);
    const streamWriter = gated.stream.getWriter();
    await streamWriter.write({ type: "write", data: new Uint8Array([1, 2, 3]), position: 0 });
    await streamWriter.close();
    expect(calls).toEqual(["write", "abort"]);
  });

  it("commits only after finalization has armed the stream", async () => {
    const calls: string[] = [];
    const writer: ExportFileWriter = {
      write: async () => { calls.push("write"); },
      close: async () => { calls.push("close"); },
      abort: async () => { calls.push("abort"); },
    };
    const gated = createCommitGatedStream(writer);
    gated.armCommit();
    const streamWriter = gated.stream.getWriter();
    await streamWriter.close();
    expect(calls).toEqual(["close"]);
  });

  it("opens the save picker synchronously in the user-activation call stack", async () => {
    let pickerCalled = false;
    const handle = { name: "replay.mp4" } as ExportFileHandle;
    const windowObject = {
      showSaveFilePicker: () => {
        pickerCalled = true;
        return Promise.resolve(handle);
      },
    } as unknown as Window;
    const navigatorObject = { storage: {} } as unknown as Navigator;

    const destinationPromise = prepareExportDestination({
      estimatedBytes: 2_000_000_000,
      suggestedName: "replay.mp4",
      windowObject,
      navigatorObject,
    });
    expect(pickerCalled).toBe(true);
    await expect(destinationPromise).resolves.toEqual({ kind: "file-system-access", handle });
  });

  it("turns a synchronous picker exception into a handled rejection", async () => {
    const failure = new DOMException("Picker blocked", "SecurityError");
    const windowObject = {
      showSaveFilePicker: () => { throw failure; },
    } as unknown as Window;
    const navigatorObject = { storage: {} } as unknown as Navigator;

    const destinationPromise = prepareExportDestination({
      estimatedBytes: 2_000_000_000,
      suggestedName: "replay.mp4",
      windowObject,
      navigatorObject,
    });

    await expect(destinationPromise).rejects.toBe(failure);
  });
});
