// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssetMediaStore } from "../src/renderer";
import type { ArchiveAsset, ImportedProject } from "../src/types";

function projectWith(asset: ArchiveAsset): ImportedProject {
  return {
    filename: "test.zip",
    chatFilename: "_chat.txt",
    chatText: "",
    chat: {
      messages: [],
      participants: [],
      preamble: [],
      diagnostics: {
        totalLines: 0,
        parsedMessages: 0,
        unparsedPreambleLines: 0,
        invalidTimestampLines: 0,
        dateOrder: "dmy",
        dateOrderAmbiguous: false,
        reversedTimestamps: 0,
        warnings: [],
      },
    },
    assets: [asset],
    attachmentStats: { matched: 0, missing: 0, ambiguous: 0, unreferenced: 1 },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("media store", () => {
  it("uses intrinsic image dimensions", async () => {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 720, height: 960, close })));
    const asset: ArchiveAsset = {
      path: "portrait.jpg",
      basename: "portrait.jpg",
      normalizedBasename: "portrait.jpg",
      size: 10,
      kind: "image",
      mimeType: "image/jpeg",
      loadBlob: async () => new Blob([new Uint8Array([1])], { type: "image/jpeg" }),
    };
    const store = new AssetMediaStore(projectWith(asset));
    await store.load(asset.path);
    expect(store.getMediaDimensions(asset.path)).toEqual({ width: 720, height: 960 });
    store.dispose();
    expect(close).toHaveBeenCalledOnce();
  });

  it("decodes animated GIF frames on timeline time", async () => {
    const closedFrames: number[] = [];
    const decoderClose = vi.fn();
    class MockFrame {
      readonly displayWidth = 320;
      readonly displayHeight = 180;
      readonly duration = 100_000;
      constructor(private readonly index: number) {}
      close(): void { closedFrames.push(this.index); }
    }
    class MockDecoder {
      static async isTypeSupported(): Promise<boolean> { return true; }
      readonly tracks = {
        ready: Promise.resolve(),
        selectedTrack: { frameCount: 2 },
      };
      async decode(options?: ImageDecodeOptions): Promise<ImageDecodeResult> {
        return { complete: true, image: new MockFrame(options?.frameIndex ?? 0) as unknown as VideoFrame };
      }
      close(): void { decoderClose(); }
    }
    vi.stubGlobal("ImageDecoder", MockDecoder);
    const asset: ArchiveAsset = {
      path: "reaction.gif",
      basename: "reaction.gif",
      normalizedBasename: "reaction.gif",
      size: 10,
      kind: "image",
      mimeType: "image/gif",
      loadBlob: async () => new Blob([new Uint8Array([1])], { type: "image/gif" }),
    };
    const store = new AssetMediaStore(projectWith(asset));
    await store.load(asset.path);
    expect(store.getMediaDimensions(asset.path)).toEqual({ width: 320, height: 180 });
    await store.prepareAnimatedFrame(asset.path, 0.11, true);
    expect(closedFrames).toContain(0);
    store.dispose();
    expect(closedFrames).toContain(1);
    expect(decoderClose).toHaveBeenCalledOnce();
  });

  it("keeps GIFs visible as a deterministic first frame without ImageDecoder", async () => {
    vi.stubGlobal("ImageDecoder", undefined);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 240, height: 180, close: vi.fn() })));
    const asset: ArchiveAsset = {
      path: "fallback.gif",
      basename: "fallback.gif",
      normalizedBasename: "fallback.gif",
      size: 10,
      kind: "image",
      mimeType: "image/gif",
      loadBlob: async () => new Blob([new Uint8Array([1])], { type: "image/gif" }),
    };
    const store = new AssetMediaStore(projectWith(asset));
    await store.load(asset.path);
    expect(store.isAnimatedImage(asset.path)).toBe(false);
    expect(store.getMediaDimensions(asset.path)).toEqual({ width: 240, height: 180 });
    store.dispose();
  });
});
