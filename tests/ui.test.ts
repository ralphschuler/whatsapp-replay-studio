// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

function canvasContextStub(): CanvasRenderingContext2D {
  const methods = new Set([
    "arc", "arcTo", "beginPath", "clip", "closePath", "drawImage", "fill", "fillRect", "fillText",
    "lineTo", "moveTo", "rect", "restore", "save", "stroke",
  ]);
  return new Proxy({} as CanvasRenderingContext2D, {
    get(target, property) {
      if (property === "measureText") return (text: string) => ({ width: [...String(text)].length * 15 });
      if (methods.has(String(property))) return () => undefined;
      return Reflect.get(target, property);
    },
    set(target, property, value) {
      return Reflect.set(target, property, value);
    },
  });
}

describe("application flow", () => {
  beforeAll(async () => {
    const source = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
    const body = source.match(/<body>([\s\S]*?)<\/body>/u)?.[1] ?? "";
    document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gu, "");
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => canvasContextStub(),
    });
    await import("../src/main");
  });

  it("starts with an empty and disabled preview", () => {
    expect((document.getElementById("editor") as HTMLElement).hidden).toBe(true);
    expect((document.getElementById("play-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("loads the demo and enables replay controls", async () => {
    (document.getElementById("demo-button") as HTMLButtonElement).click();
    expect((document.getElementById("editor") as HTMLElement).hidden).toBe(false);
    expect(document.getElementById("stat-messages")?.textContent).toBe("7");
    await vi.waitFor(() => {
      expect((document.getElementById("play-button") as HTMLButtonElement).disabled).toBe(false);
    });
    const selfSelect = document.getElementById("self-name") as HTMLSelectElement;
    expect(selfSelect.options.length).toBe(4);
    expect(selfSelect.value).toBe("Ralph");
    expect(Number((document.getElementById("scrubber") as HTMLInputElement).max)).toBeGreaterThan(1);
    expect((document.getElementById("incoming-sound") as HTMLInputElement).checked).toBe(true);
  });

  it("updates format and anonymization without losing the project", () => {
    const preset = document.getElementById("preset") as HTMLSelectElement;
    preset.value = "square-1080";
    preset.dispatchEvent(new Event("change"));
    const canvas = document.getElementById("preview-canvas") as HTMLCanvasElement;
    expect(canvas.width).toBe(1080);
    expect(canvas.height).toBe(1080);
    const anonymize = document.getElementById("anonymize") as HTMLInputElement;
    anonymize.click();
    expect(anonymize.checked).toBe(true);
    expect(document.getElementById("stat-messages")?.textContent).toBe("7");
  });

  it("keeps the chosen sender when the date format is reparsed", async () => {
    const selfSelect = document.getElementById("self-name") as HTMLSelectElement;
    selfSelect.value = "Mia";
    selfSelect.dispatchEvent(new Event("input"));
    const dateOrder = document.getElementById("date-order") as HTMLSelectElement;
    dateOrder.value = "auto";
    dateOrder.dispatchEvent(new Event("change"));
    expect(selfSelect.value).toBe("Mia");
    await vi.waitFor(() => {
      expect((document.getElementById("play-button") as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("infers the owner from a direct-chat filename without carrying over the old selection", async () => {
    const file = new File([
      "20.07.26, 09:03 - Mia: Eingehend\n20.07.26, 09:04 - Ralph: Ausgehend",
    ], "WhatsApp Chat - Mia.txt", { type: "text/plain" });
    const fileInput = document.getElementById("file-input") as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    fileInput.dispatchEvent(new Event("change"));
    const selfSelect = document.getElementById("self-name") as HTMLSelectElement;
    await vi.waitFor(() => expect(selfSelect.value).toBe("Ralph"));
    expect((document.getElementById("chat-title") as HTMLInputElement).value).toBe("Mia");
    await vi.waitFor(() => {
      expect((document.getElementById("play-button") as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("requires an explicit owner for an ambiguous group export", async () => {
    const file = new File([
      [
        "20.07.26, 09:03 - Mia: Eins",
        "20.07.26, 09:04 - Ralph: Zwei",
        "20.07.26, 09:05 - Tom: Drei",
      ].join("\n"),
    ], "WhatsApp Chat - Mia.txt", { type: "text/plain" });
    const fileInput = document.getElementById("file-input") as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    fileInput.dispatchEvent(new Event("change"));
    const selfSelect = document.getElementById("self-name") as HTMLSelectElement;
    await vi.waitFor(() => expect(document.getElementById("stat-messages")?.textContent).toBe("3"));
    expect(selfSelect.value).toBe("");
    expect(selfSelect.getAttribute("aria-invalid")).toBe("true");
    expect((document.getElementById("play-button") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("export-button") as HTMLButtonElement).disabled).toBe(true);
  });
});
