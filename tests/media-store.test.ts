// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssetMediaStore, MAX_CACHED_STATIC_IMAGE_EDGE, MAX_VISUAL_WORKING_SET_ITEMS } from "../src/renderer";
import type { ArchiveAsset, ChatMessage, ImportedProject } from "../src/types";

function projectWith(asset: ArchiveAsset): ImportedProject {
  return projectWithAssets([asset]);
}

function projectWithAssets(assets: ArchiveAsset[], messages: ChatMessage[] = []): ImportedProject {
  return {
    filename: "test.zip",
    chatFilename: "_chat.txt",
    chatText: "",
    chat: {
      messages,
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
    assets,
    attachmentStats: { matched: 0, missing: 0, ambiguous: 0, unreferenced: 1 },
  };
}

function imageMessage(asset: ArchiveAsset, index: number): ChatMessage {
  return {
    id: `image-${index}`,
    sourceOrder: index,
    timestamp: new Date(2026, 6, 20, 10, index),
    rawTimestamp: "",
    precision: "minute",
    sender: "Ralph",
    text: asset.basename,
    kind: "media",
    mediaReference: asset.basename,
    attachment: {
      archivePath: asset.path,
      displayName: asset.basename,
      kind: "image",
      mimeType: asset.mimeType,
      size: asset.size,
      status: "found",
    },
    warnings: [],
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
    expect(close).toHaveBeenCalledTimes(2);
    expect(store.getMediaDimensions(asset.path)).toBeUndefined();
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
    // Direct loading first uses a short-lived metadata decoder and then keeps
    // one decoder for timeline frames until disposal.
    expect(decoderClose).toHaveBeenCalledTimes(2);
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

  it("downsamples a large static GIF fallback while preserving its intrinsic dimensions", async () => {
    vi.stubGlobal("ImageDecoder", undefined);
    const decoded: { width: number; height: number; close: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal("createImageBitmap", vi.fn(async (_source: ImageBitmapSource, options?: ImageBitmapOptions) => {
      const close = vi.fn();
      const bitmap = {
        width: options?.resizeWidth ?? 4_000,
        height: options?.resizeHeight ?? 3_000,
        close,
      };
      decoded.push(bitmap);
      return bitmap;
    }));
    const asset: ArchiveAsset = {
      path: "large-fallback.gif",
      basename: "large-fallback.gif",
      normalizedBasename: "large-fallback.gif",
      size: 10,
      kind: "image",
      mimeType: "image/gif",
      loadBlob: async () => new Blob([new Uint8Array([1])], { type: "image/gif" }),
    };
    const message = imageMessage(asset, 0);
    const store = new AssetMediaStore(projectWithAssets([asset], [message]));

    await store.preloadForMessages([message]);
    await store.load(asset.path);

    expect(store.getMediaDimensions(asset.path)).toEqual({ width: 4_000, height: 3_000 });
    expect(store.getImage(asset.path)).toMatchObject({
      width: MAX_CACHED_STATIC_IMAGE_EDGE,
      height: 1_536,
    });
    expect(decoded).toHaveLength(2);
    expect(decoded[0]!.close).toHaveBeenCalledOnce();
    expect(decoded[1]!.close).not.toHaveBeenCalled();
    store.dispose();
    expect(decoded[1]!.close).toHaveBeenCalledOnce();
  });

  it("loads VCard contact details for the contact attachment card", async () => {
    const asset: ArchiveAsset = {
      path: "Max.vcf",
      basename: "Max.vcf",
      normalizedBasename: "max.vcf",
      size: 120,
      kind: "document",
      mimeType: "text/vcard",
      loadBlob: async () => new Blob([
        "BEGIN:VCARD\nFN:Max Mustermann\nTEL:+49 123\nEMAIL:max@example.com\nEND:VCARD",
      ], { type: "text/vcard" }),
    };
    const store = new AssetMediaStore(projectWith(asset));
    await store.load(asset.path);
    expect(store.getContactCard(asset.path)).toEqual({
      name: "Max Mustermann",
      phones: ["+49 123"],
      emails: ["max@example.com"],
    });
    store.dispose();
    expect(store.getContactCard(asset.path)).toBeUndefined();
  });

  it("preflights image dimensions without retaining decoded pixels", async () => {
    const closes: ReturnType<typeof vi.fn>[] = [];
    const createBitmap = vi.fn(async () => {
      const close = vi.fn();
      closes.push(close);
      return { width: 1_200, height: 900, close };
    });
    vi.stubGlobal("createImageBitmap", createBitmap);
    const assets = Array.from({ length: 18 }, (_, index): ArchiveAsset => ({
      path: `photo-${index}.jpg`,
      basename: `photo-${index}.jpg`,
      normalizedBasename: `photo-${index}.jpg`,
      size: 10,
      kind: "image",
      mimeType: "image/jpeg",
      loadBlob: async () => new Blob([new Uint8Array([index])], { type: "image/jpeg" }),
    }));
    const store = new AssetMediaStore(projectWithAssets(assets, assets.map(imageMessage)));

    await store.preloadForMessages(assets.map(imageMessage));

    expect(createBitmap).toHaveBeenCalledTimes(assets.length);
    expect(closes.every((close) => close.mock.calls.length === 1)).toBe(true);
    for (const asset of assets) {
      expect(store.getMediaDimensions(asset.path)).toEqual({ width: 1_200, height: 900 });
      expect(store.getImage(asset.path)).toBeUndefined();
    }
    store.dispose();
    expect(store.getMediaDimensions(assets[0]!.path)).toBeUndefined();
  });

  it("stops metadata preflight after an abort instead of probing the remaining archive", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 640, height: 480, close: vi.fn() })));
    const loadBlob = vi.fn(async () => new Blob([new Uint8Array([1])], { type: "image/jpeg" }));
    const assets = Array.from({ length: 20 }, (_, index): ArchiveAsset => ({
      path: `abort-${index}.jpg`,
      basename: `abort-${index}.jpg`,
      normalizedBasename: `abort-${index}.jpg`,
      size: 10,
      kind: "image",
      mimeType: "image/jpeg",
      loadBlob,
    }));
    const messages = assets.map(imageMessage);
    const store = new AssetMediaStore(projectWithAssets(assets, messages));
    const controller = new AbortController();

    await expect(store.preloadForMessages(messages, (done) => {
      if (done === 1) controller.abort();
    }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });

    expect(loadBlob).toHaveBeenCalledOnce();
    expect(store.getMediaDimensions(assets[0]!.path)).toEqual({ width: 640, height: 480 });
    expect(store.getMediaDimensions(assets[1]!.path)).toBeUndefined();
    store.dispose();
  });

  it("evicts decoded visuals as the replay advances", async () => {
    const decoded: { pathIndex: number; close: ReturnType<typeof vi.fn> }[] = [];
    let bitmapIndex = 0;
    vi.stubGlobal("createImageBitmap", vi.fn(async () => {
      const close = vi.fn();
      decoded.push({ pathIndex: bitmapIndex++, close });
      return { width: 320, height: 240, close };
    }));
    const assets = Array.from({ length: MAX_VISUAL_WORKING_SET_ITEMS + 3 }, (_, index): ArchiveAsset => ({
      path: `thumb-${index}.jpg`,
      basename: `thumb-${index}.jpg`,
      normalizedBasename: `thumb-${index}.jpg`,
      size: 10,
      kind: "image",
      mimeType: "image/jpeg",
      loadBlob: async () => new Blob([new Uint8Array([index])], { type: "image/jpeg" }),
    }));
    const messages = assets.map(imageMessage);
    const store = new AssetMediaStore(projectWithAssets(assets, messages));
    await store.preloadForMessages(messages);

    const firstWorkingSet = await store.prepareVisualWorkingSet(assets.map((asset) => asset.path));
    expect(firstWorkingSet.size).toBe(MAX_VISUAL_WORKING_SET_ITEMS);
    expect(firstWorkingSet.has(assets[0]!.path)).toBe(false);
    expect(store.getImage(assets.at(-1)!.path)).toBeDefined();
    const activeDecodes = decoded.slice(assets.length);
    expect(activeDecodes).toHaveLength(MAX_VISUAL_WORKING_SET_ITEMS);
    expect(activeDecodes.every(({ close }) => close.mock.calls.length === 0)).toBe(true);

    await store.prepareVisualWorkingSet([assets[0]!.path]);
    expect(activeDecodes.every(({ close }) => close.mock.calls.length === 1)).toBe(true);
    expect(store.getImage(assets.at(-1)!.path)).toBeUndefined();
    expect(store.getImage(assets[0]!.path)).toBeDefined();
    store.dispose();
  });

  it("downsamples large cached images without omitting the newest visible media", async () => {
    const decoded: { width: number; height: number; close: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal("createImageBitmap", vi.fn(async (_source: ImageBitmapSource, options?: ImageBitmapOptions) => {
      const close = vi.fn();
      const bitmap = {
        width: options?.resizeWidth ?? 4_000,
        height: options?.resizeHeight ?? 3_000,
        close,
      };
      decoded.push(bitmap);
      return bitmap;
    }));
    const assets = Array.from({ length: 4 }, (_, index): ArchiveAsset => ({
      path: `large-${index}.jpg`,
      basename: `large-${index}.jpg`,
      normalizedBasename: `large-${index}.jpg`,
      size: 10,
      kind: "image",
      mimeType: "image/jpeg",
      loadBlob: async () => new Blob([new Uint8Array([index])], { type: "image/jpeg" }),
    }));
    const messages = assets.map(imageMessage);
    const store = new AssetMediaStore(projectWithAssets(assets, messages));
    await store.preloadForMessages(messages);

    const workingSet = await store.prepareVisualWorkingSet(assets.map((asset) => asset.path));
    expect(workingSet.size).toBe(assets.length);
    for (const asset of assets) {
      expect(workingSet.has(asset.path)).toBe(true);
      expect(store.getMediaDimensions(asset.path)).toEqual({ width: 4_000, height: 3_000 });
      const image = store.getImage(asset.path);
      expect(image?.width).toBe(MAX_CACHED_STATIC_IMAGE_EDGE);
      expect(image?.height).toBe(1_536);
    }
    const metadataDecodes = decoded.slice(0, assets.length);
    const cachedDecodes = decoded.slice(assets.length);
    expect(metadataDecodes.every(({ close }) => close.mock.calls.length === 1)).toBe(true);
    expect(cachedDecodes).toHaveLength(assets.length);
    expect(cachedDecodes.every(({ close }) => close.mock.calls.length === 0)).toBe(true);

    await store.prepareVisualWorkingSet([]);
    expect(cachedDecodes.every(({ close }) => close.mock.calls.length === 1)).toBe(true);
    expect(store.getImage(assets.at(-1)!.path)).toBeUndefined();
    store.dispose();
  });
});
