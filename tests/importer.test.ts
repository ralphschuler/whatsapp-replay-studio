// @vitest-environment happy-dom
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { importWhatsAppExport, sniffMediaSignature } from "../src/importer";

describe("ZIP importer", () => {
  it("recognizes common media containers from their bytes", () => {
    expect(sniffMediaSignature(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "wrong.bin")).toEqual({ kind: "image", mimeType: "image/jpeg" });
    expect(sniffMediaSignature(new Uint8Array([0x4f, 0x67, 0x67, 0x53]), "wrong.bin")).toEqual({ kind: "audio", mimeType: "audio/ogg" });
    expect(sniffMediaSignature(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), "wrong.bin")).toEqual({ kind: "video", mimeType: "video/webm" });
    expect(sniffMediaSignature(new Uint8Array([0xff, 0xf1, 0x50, 0x80]), "voice.bin")).toEqual({ kind: "audio", mimeType: "audio/aac" });
    expect(sniffMediaSignature(new Uint8Array([0x4f, 0x67, 0x67, 0x53]), "clip.ogv")).toEqual({ kind: "video", mimeType: "video/ogg" });
    expect(sniffMediaSignature(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), "voice.weba")).toEqual({ kind: "audio", mimeType: "audio/webm" });
    expect(sniffMediaSignature(new Uint8Array([0x63, 0x61, 0x66, 0x66]), "voice.bin")).toEqual({ kind: "audio", mimeType: "audio/x-caf" });
    expect(sniffMediaSignature(new Uint8Array([0x46, 0x4f, 0x52, 0x4d, 0, 0, 0, 0, 0x41, 0x49, 0x46, 0x46]), "voice.bin")).toEqual({ kind: "audio", mimeType: "audio/aiff" });
    expect(sniffMediaSignature(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]), "voice.3ga")).toEqual({ kind: "audio", mimeType: "audio/3gpp" });
    expect(sniffMediaSignature(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x33, 0x67, 0x70, 0x34, 0, 0, 0, 0]), "clip.3gp")).toEqual({ kind: "video", mimeType: "video/3gpp" });
    expect(sniffMediaSignature(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]), "Postkarte.webp")).toEqual({ kind: "image", mimeType: "image/webp" });
    expect(sniffMediaSignature(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]), "STK-123.webp")).toEqual({ kind: "sticker", mimeType: "image/webp" });
  });

  it("associates localized iOS attachment tags with ZIP assets", async () => {
    const zip = new JSZip();
    const filenames = ["photo.jpg", "clip.mov", "animation.mp4", "voice.opus", "reaction.gif", "contact.vcf", "legacy.3gp", "memo.amr"];
    zip.file("_chat.txt", filenames.map((filename, index) =>
      `[17.07.26, 09:57:${String(50 + index).padStart(2, "0")}] Ralph: \u200e<Anhang: ${filename}>`,
    ).join("\n"));
    for (const filename of filenames) zip.file(filename, new Uint8Array([1, 2, 3, 4]));
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const file = new File([buffer], "WhatsApp Chat.zip", { type: "application/zip" });

    const project = await importWhatsAppExport(file);

    expect(project.assets).toHaveLength(8);
    expect(project.attachmentStats).toMatchObject({ matched: 8, missing: 0, ambiguous: 0, unreferenced: 0 });
    expect(project.chat.messages.map((message) => message.attachment?.kind)).toEqual([
      "image", "video", "video", "audio", "image", "document", "video", "audio",
    ]);
  });

  it("resolves every explicitly referenced attachment in transcript order", async () => {
    const zip = new JSZip();
    zip.file("_chat.txt", [
      "[17.07.26, 09:57:57] Mia: Unser Album",
      "\u200e<Anhang: Media/clip.mov>",
      "\u200e<attached: Audio/voice.opus>",
      "\u200e<Datei: Animation/reaction.gif>",
    ].join("\n"));

    // Deliberately add the ZIP entries in another order. The transcript's exact
    // references, never archive order or a similar basename, define the mapping.
    zip.file("Animation/reaction.gif", new Uint8Array([0x47, 0x49, 0x46, 0x38]));
    zip.file("Decoys/voice.opus", new Uint8Array([9]));
    zip.file("Media/clip.mov", new Uint8Array([1, 2, 3, 4]));
    zip.file("Decoys/reaction.gif", new Uint8Array([9]));
    zip.file("Audio/voice.opus", new Uint8Array([0x4f, 0x67, 0x67, 0x53]));
    zip.file("Decoys/clip.mov", new Uint8Array([9]));
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

    const project = await importWhatsAppExport(new File([buffer], "Chat.zip", { type: "application/zip" }));

    expect(project.chat.messages.map((message) => message.mediaReference)).toEqual([
      "Media/clip.mov",
      "Audio/voice.opus",
      "Animation/reaction.gif",
    ]);
    expect(project.chat.messages.map((message) => message.attachment?.archivePath)).toEqual([
      "Media/clip.mov",
      "Audio/voice.opus",
      "Animation/reaction.gif",
    ]);
    expect(project.chat.messages.map((message) => message.attachmentGroup)).toEqual([
      { id: "msg-0", index: 0, size: 3, kind: "explicit-multi" },
      { id: "msg-0", index: 1, size: 3, kind: "explicit-multi" },
      { id: "msg-0", index: 2, size: 3, kind: "explicit-multi" },
    ]);
    expect(project.chat.messages.map((message) => message.displayText)).toEqual(["Unser Album", "", ""]);
    expect(project.attachmentStats).toEqual({ matched: 3, missing: 0, ambiguous: 0, unreferenced: 3 });
  });

  it("marks attachment references as missing in a TXT-only export", async () => {
    const file = new File([
      "[17.07.26, 09:57:57] Ralph: <Anhang: voice.opus>",
    ], "_chat.txt", { type: "text/plain" });

    const project = await importWhatsAppExport(file);

    expect(project.attachmentStats.missing).toBe(1);
    expect(project.chat.messages[0]?.attachment).toMatchObject({
      displayName: "voice.opus",
      kind: "audio",
      status: "missing",
    });
  });

  it("does not associate type-less omitted markers by unreliable ZIP order", async () => {
    const zip = new JSZip();
    zip.file("_chat.txt", [
      "[17.07.26, 09:57:57] Ralph: <Media omitted>",
      "[17.07.26, 09:57:58] Ralph: <Media omitted>",
    ].join("\n"));
    zip.file("first.opus", new Uint8Array([1]));
    zip.file("second.jpg", new Uint8Array([2]));
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

    const project = await importWhatsAppExport(new File([buffer], "Chat.zip", { type: "application/zip" }));

    expect(project.chat.messages.map((message) => message.attachment)).toEqual([undefined, undefined]);
    expect(project.attachmentStats).toMatchObject({ matched: 0, missing: 0, ambiguous: 0, unreferenced: 2 });
  });

  it("imports arbitrary safe attachment extensions referenced by the transcript", async () => {
    const zip = new JSZip();
    const files = [
      ["Termin.ics", "text/calendar"],
      ["Präsentation.key", "application/vnd.apple.keynote"],
      ["daten.json", "application/json"],
      ["Notizen.md", "text/markdown"],
      ["readme.txt", "text/plain"],
      ["payload.bin", "application/octet-stream"],
    ] as const;
    zip.file("_chat.txt", files.map(([filename], index) =>
      `[17.07.26, 10:01:${String(index).padStart(2, "0")}] Ralph: <Anhang: ${filename}>`,
    ).join("\n"));
    for (const [filename] of files) zip.file(filename, new Uint8Array([1, 2, 3]));
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

    const project = await importWhatsAppExport(new File([buffer], "Chat.zip", { type: "application/zip" }));

    expect(project.assets.map((asset) => [asset.basename, asset.kind, asset.mimeType])).toEqual(
      files.map(([filename, mimeType]) => [filename, "document", mimeType]),
    );
    expect(project.chat.messages.map((message) => message.attachment?.displayName)).toEqual(
      files.map(([filename]) => filename),
    );
    expect(project.chat.messages.every((message) => message.attachment?.status === "found")).toBe(true);
    expect(project.attachmentStats).toEqual({ matched: files.length, missing: 0, ambiguous: 0, unreferenced: 0 });
  });

  it("imports and associates an explicitly attached extensionless document", async () => {
    const zip = new JSZip();
    zip.file("_chat.txt", "[17.07.26, 09:57:57] Ralph: <attached: LICENSE>");
    zip.file("LICENSE", "license text");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

    const project = await importWhatsAppExport(new File([buffer], "Chat.zip", { type: "application/zip" }));

    expect(project.assets.map((asset) => asset.basename)).toContain("LICENSE");
    expect(project.chat.messages[0]?.attachment).toMatchObject({
      displayName: "LICENSE",
      kind: "document",
      status: "found",
    });
    expect(project.attachmentStats).toMatchObject({ matched: 1, missing: 0, ambiguous: 0 });
  });

  it("uses an exported relative path before an ambiguous basename fallback", async () => {
    const zip = new JSZip();
    zip.file("_chat.txt", "[17.07.26, 09:57:57] Ralph: <attached: Media/photo.jpg>");
    zip.file("Media/photo.jpg", new Uint8Array([1]));
    zip.file("Archive/photo.jpg", new Uint8Array([2]));
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

    const project = await importWhatsAppExport(new File([buffer], "Chat.zip", { type: "application/zip" }));

    expect(project.chat.messages[0]?.attachment).toMatchObject({
      archivePath: "Media/photo.jpg",
      status: "found",
    });
    expect(project.attachmentStats).toMatchObject({ matched: 1, ambiguous: 0, unreferenced: 1 });
  });

  it("does not replace a missing explicit path with a same-basename ZIP entry", async () => {
    const zip = new JSZip();
    zip.file("_chat.txt", "[17.07.26, 09:57:57] Ralph: <attached: Media/photo.jpg>");
    zip.file("Archive/photo.jpg", new Uint8Array([1]));
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

    const project = await importWhatsAppExport(new File([buffer], "Chat.zip", { type: "application/zip" }));

    expect(project.chat.messages[0]?.attachment).toMatchObject({
      archivePath: "",
      displayName: "Media/photo.jpg",
      status: "missing",
    });
    expect(project.attachmentStats).toEqual({ matched: 0, missing: 1, ambiguous: 0, unreferenced: 1 });
  });

  it("prefers a valid standard _chat.txt over a timestamp-heavy attached text document", async () => {
    const zip = new JSZip();
    zip.file("_chat.txt", "[17.07.26, 09:57:57] Ralph: Richtiger Chat");
    zip.file("server-log.txt", Array.from(
      { length: 30 },
      (_, index) => `[17.07.26, 09:58:${String(index).padStart(2, "0")}] Service: Log ${index}`,
    ).join("\n"));
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

    const project = await importWhatsAppExport(new File([buffer], "Chat.zip", { type: "application/zip" }));

    expect(project.chatFilename).toBe("_chat.txt");
    expect(project.chat.messages).toHaveLength(1);
    expect(project.chat.messages[0]?.text).toBe("Richtiger Chat");
  });

  it("promotes a wrongly named referenced MP4 container from document to video", async () => {
    const zip = new JSZip();
    zip.file("_chat.txt", "[17.07.26, 09:57:57] Ralph: <attached: strange.bin>");
    zip.file("strange.bin", new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x00,
    ]));
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

    const project = await importWhatsAppExport(new File([buffer], "Chat.zip", { type: "application/zip" }));

    expect(project.chat.messages[0]?.attachment).toMatchObject({
      displayName: "strange.bin",
      kind: "video",
      mimeType: "video/mp4",
      status: "found",
    });
  });
});
