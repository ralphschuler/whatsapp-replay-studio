import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import JSZip from "jszip";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function pcmWave(durationSeconds = 0.12, sampleRate = 8_000): Buffer {
  const sampleCount = Math.max(1, Math.round(durationSeconds * sampleRate));
  const bytesPerSample = 2;
  const dataLength = sampleCount * bytesPerSample;
  const wave = Buffer.alloc(44 + dataLength);

  wave.write("RIFF", 0, "ascii");
  wave.writeUInt32LE(36 + dataLength, 4);
  wave.write("WAVE", 8, "ascii");
  wave.write("fmt ", 12, "ascii");
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20); // PCM
  wave.writeUInt16LE(1, 22); // mono
  wave.writeUInt32LE(sampleRate, 24);
  wave.writeUInt32LE(sampleRate * bytesPerSample, 28);
  wave.writeUInt16LE(bytesPerSample, 32);
  wave.writeUInt16LE(16, 34);
  wave.write("data", 36, "ascii");
  wave.writeUInt32LE(dataLength, 40);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const value = Math.sin(2 * Math.PI * 440 * sample / sampleRate) * 0.15;
    wave.writeInt16LE(Math.round(value * 0x7fff), 44 + sample * bytesPerSample);
  }
  return wave;
}

async function whatsappZip(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("_chat.txt", [
    "[18.07.26, 18:42:03] Mia: Medien aus dem Browser-Test",
    "\u200e<attached: media/test-image.png>",
    "\u200e<attached: media/test-tone.wav>",
    "[18.07.26, 18:42:04] Ralph: Ist angekommen.",
  ].join("\n"));
  zip.file("media/test-image.png", PNG_1X1);
  zip.file("media/test-tone.wav", pcmWave());
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function openWithoutNativeFileStorage(page: Page): Promise<{
  pageErrors: Error[];
  navigations: () => number;
}> {
  // The production app prefers showSaveFilePicker/OPFS for large exports. A
  // short E2E clip deliberately exercises its safe in-memory fallback so CI
  // never opens a native dialog or leaves browser-storage artifacts behind.
  await page.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: undefined,
    });
    if (navigator.storage) {
      Object.defineProperty(navigator.storage, "getDirectory", {
        configurable: true,
        value: undefined,
      });
    }
  });

  const pageErrors: Error[] = [];
  let navigationCount = 0;
  page.on("pageerror", (error) => pageErrors.push(error));
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigationCount += 1;
  });
  await page.goto("/", { waitUntil: "networkidle" });
  return { pageErrors, navigations: () => navigationCount };
}

async function expectPlaybackToAdvance(page: Page): Promise<void> {
  const play = page.locator("#play-button");
  const scrubber = page.locator("#scrubber");
  const before = Number(await scrubber.inputValue());

  await play.click();
  await expect(play).toHaveAttribute("aria-label", "Vorschau pausieren");
  await expect.poll(async () => Number(await scrubber.inputValue())).toBeGreaterThan(before + 0.05);
  await play.click();
  await expect(play).toHaveAttribute("aria-label", "Vorschau abspielen");
}

test("Demo-Chat enables Play and advances the replay clock", async ({ page }) => {
  const runtime = await openWithoutNativeFileStorage(page);

  await page.locator("#demo-button").click();
  await expect(page.locator("#stat-messages")).toHaveText("7");
  await expect(page.locator("#play-button")).toBeEnabled();
  await expectPlaybackToAdvance(page);

  expect(runtime.navigations()).toBe(1);
  expect(runtime.pageErrors).toEqual([]);
});

test("uploads a media ZIP and exports a complete short MP4", async ({ page }, testInfo) => {
  const runtime = await openWithoutNativeFileStorage(page);
  const fixtureDirectory = testInfo.outputPath("fixture");
  const fixturePath = `${fixtureDirectory}/WhatsApp Chat - Mia.zip`;
  await mkdir(fixtureDirectory, { recursive: true });
  await writeFile(fixturePath, await whatsappZip());

  await page.locator("#file-input").setInputFiles(fixturePath);
  await expect(page.locator("#stat-messages")).toHaveText("2");
  await expect(page.locator("#stat-media")).toHaveText("2");
  await expect(page.locator("#self-name")).toHaveValue("Ralph");
  await expect(page.locator("#play-button")).toBeEnabled();
  await expectPlaybackToAdvance(page);

  // The first logical WhatsApp message owns both attachment records. Keeping
  // only that group makes the real browser encode deterministic and short.
  await page.locator("#end-range").evaluate((element) => {
    const range = element as HTMLInputElement;
    range.value = "0";
    range.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect.poll(async () => Number(await page.locator("#scrubber").getAttribute("max"))).toBeLessThan(10);

  const codecSupport = await page.evaluate(async () => {
    const video = "VideoEncoder" in window
      && (await VideoEncoder.isConfigSupported({
        codec: "avc1.42001f",
        width: 720,
        height: 1280,
        bitrate: 4_000_000,
        framerate: 30,
      })).supported;
    const audio = "AudioEncoder" in window
      && (await AudioEncoder.isConfigSupported({
        codec: "mp4a.40.2",
        sampleRate: 48_000,
        numberOfChannels: 2,
        bitrate: 128_000,
      })).supported;
    return { video, audio };
  });
  expect(codecSupport, "Chrome must provide the AVC/AAC WebCodecs used by the exporter").toEqual({
    video: true,
    audio: true,
  });

  await page.locator("#export-button").click();
  await expect(page.locator("#render-overlay")).toBeVisible();
  await expect(page.locator("#download-card")).toBeVisible({ timeout: 210_000 });
  await expect(page.locator("#render-percent")).toHaveText("100 %");

  const downloadEvent = page.waitForEvent("download");
  await page.locator("#download-link").click();
  const download = await downloadEvent;
  const downloadedPath = await download.path();
  expect(downloadedPath, "Playwright should retain the generated MP4").not.toBeNull();
  const mp4 = await readFile(downloadedPath!);

  expect(download.suggestedFilename()).toMatch(/\.mp4$/u);
  expect(mp4.byteLength).toBeGreaterThan(1_024);
  expect(mp4.subarray(4, 8).toString("ascii")).toBe("ftyp");
  expect(mp4.includes(Buffer.from("mdat", "ascii"))).toBe(true);
  expect(mp4.includes(Buffer.from("moov", "ascii"))).toBe(true);
  expect(runtime.navigations(), "the application must not reload while exporting").toBe(1);
  expect(runtime.pageErrors).toEqual([]);
});
