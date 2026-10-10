import { PDF } from "#src/api/pdf";
import { loadFixture } from "#src/test-utils";
import { createHash } from "node:crypto";
import { decodePDFRawStream, PDFDict, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { expect, it } from "vitest";

it("preserves Japanese text in flattened fields sharing a full embedded font", async () => {
  const fontBytes = await loadFixture("fonts", "ttf/NotoSansJP-Regular.ttf");
  const pdf = PDF.create();
  const page = pdf.addPage({ size: "a4" });
  const form = pdf.getOrCreateForm();
  const font = pdf.embedFont(fontBytes);
  const values = ["pdf-test@example.com", "2026年9月16日", "synthetic-document-id"];

  for (const [index, value] of values.entries()) {
    const field = form.createTextField(`field${index}`);
    field.setFont(font);
    field.setValue(value);
    page.drawField(field, { x: 30, y: 700 - index * 60, width: 500, height: 40 });
  }

  form.flatten();
  expect(font.canSubset()).toBe(false);
  const bytes = await pdf.save();

  // Inspect the saved objects with an independent PDF parser.
  const saved = await PDFDocument.load(bytes);
  expect(saved.getPageCount()).toBe(1);
  expect(saved.getForm().getFields()).toHaveLength(0);
  const fontPrograms: Uint8Array[] = [];
  const cmaps: string[] = [];

  for (const [, object] of saved.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) {
      continue;
    }

    for (const key of ["FontFile2", "ToUnicode"]) {
      if (!object.has(PDFName.of(key))) {
        continue;
      }

      const stream = object.lookup(PDFName.of(key));

      if (!(stream instanceof PDFRawStream)) {
        throw new Error(`Expected a stream for ${key}`);
      }

      const data = decodePDFRawStream(stream).decode();

      if (key === "FontFile2") {
        fontPrograms.push(data);
      } else {
        cmaps.push(new TextDecoder().decode(data));
      }
    }
  }

  expect(fontPrograms).toHaveLength(1);
  expect(createHash("sha256").update(fontPrograms[0]).digest("hex")).toBe(
    createHash("sha256").update(fontBytes).digest("hex"),
  );
  expect(cmaps).toHaveLength(1);

  for (const character of "年月日") {
    const codePoint = character.codePointAt(0)!;
    const gid = font.program.getGlyphId(codePoint).toString(16).toUpperCase().padStart(4, "0");
    const unicode = codePoint.toString(16).toUpperCase().padStart(4, "0");
    expect(cmaps[0]).toContain(`<${gid}> <${unicode}>`);
  }

  const reloaded = await PDF.load(bytes);
  const text = reloaded.getPage(0)!.extractText().text;

  for (const value of values) {
    expect(text).toContain(value);
  }
});
