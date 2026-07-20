// @vitest-environment happy-dom
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { importWhatsAppExport } from "../src/importer";

describe("ZIP importer", () => {
  it("associates localized iOS attachment tags with ZIP assets", async () => {
    const zip = new JSZip();
    const filenames = ["photo.jpg", "clip.mov", "animation.mp4", "voice.opus"];
    zip.file("_chat.txt", filenames.map((filename, index) =>
      `[17.07.26, 09:57:${String(50 + index).padStart(2, "0")}] Ralph: \u200e<Anhang: ${filename}>`,
    ).join("\n"));
    for (const filename of filenames) zip.file(filename, new Uint8Array([1, 2, 3, 4]));
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const file = new File([buffer], "WhatsApp Chat.zip", { type: "application/zip" });

    const project = await importWhatsAppExport(file);

    expect(project.assets).toHaveLength(4);
    expect(project.attachmentStats).toMatchObject({ matched: 4, missing: 0, ambiguous: 0, unreferenced: 0 });
    expect(project.chat.messages.map((message) => message.attachment?.kind)).toEqual(["image", "video", "video", "audio"]);
  });
});
