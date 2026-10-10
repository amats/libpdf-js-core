import { PDF } from "#src/api/pdf";
import { EmbeddedFont } from "#src/fonts/embedded-font";
import { PdfDict } from "#src/objects/pdf-dict";
import { PdfName } from "#src/objects/pdf-name";
import { PdfString } from "#src/objects/pdf-string";
import { loadFixture } from "#src/test-utils";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { resolveAppearanceFont } from "./appearance-utils";
import { ExistingFont, type FormFont } from "./form-font";

describe("resolveAppearanceFont", () => {
  let latinFont: EmbeddedFont;
  let japaneseFont: EmbeddedFont;

  beforeAll(async () => {
    latinFont = EmbeddedFont.fromBytes(
      await loadFixture("fonts", "ttf/LiberationSans-Regular.ttf"),
    );
    japaneseFont = EmbeddedFont.fromBytes(await loadFixture("fonts", "ttf/NotoSansJP-Regular.ttf"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createField(font?: FormFont) {
    const pdf = PDF.create();
    const form = pdf.getOrCreateForm();
    const field = form.createTextField("text");

    if (font) {
      field.setFont(font);
    }

    const acroForm = form.acroForm();
    const defaultFont = vi.spyOn(acroForm, "getDefaultFont");
    const existingFont = vi.spyOn(acroForm, "getExistingFont");
    const availableFonts = vi.spyOn(acroForm, "getAvailableFonts");

    return { pdf, field, acroForm, defaultFont, existingFont, availableFonts };
  }

  it.each(["Hello", ""])("skips fallback lookup for a usable explicit embedded font (%j)", text => {
    const { field, acroForm, defaultFont, existingFont, availableFonts } = createField(latinFont);
    acroForm.setDefaultFont(japaneseFont);

    expect(resolveAppearanceFont(acroForm, field, text, "/Unused")).toBe(latinFont);
    expect(defaultFont).not.toHaveBeenCalled();
    expect(existingFont).not.toHaveBeenCalled();
    expect(availableFonts).not.toHaveBeenCalled();
  });

  it("keeps fallback lookup when the explicit font cannot encode the text", () => {
    const { field, acroForm, existingFont, availableFonts } = createField(latinFont);
    acroForm.setDefaultFont(japaneseFont);
    expect(latinFont.canEncode("年月日")).toBe(false);

    expect(resolveAppearanceFont(acroForm, field, "年月日")).toBe(japaneseFont);
    expect(existingFont).toHaveBeenCalled();
    expect(availableFonts).toHaveBeenCalled();
  });

  it("uses the default font when there is no explicit font", () => {
    const { field, acroForm, existingFont, availableFonts } = createField();
    acroForm.setDefaultFont(japaneseFont);

    expect(resolveAppearanceFont(acroForm, field, "年月日")).toBe(japaneseFont);
    expect(existingFont).toHaveBeenCalled();
    expect(availableFonts).toHaveBeenCalled();
  });

  it("retains a usable explicit Standard 14 font and the existing lookup path", () => {
    const standardFont = new ExistingFont("Helv", null);
    const { field, acroForm, existingFont, availableFonts } = createField(standardFont);
    acroForm.setDefaultFont(latinFont);

    expect(resolveAppearanceFont(acroForm, field, "Hello")).toBe(standardFont);
    expect(existingFont).toHaveBeenCalled();
    expect(availableFonts).toHaveBeenCalled();
  });

  it("falls back from an unusable existing font to a usable default font", () => {
    const { field, acroForm, availableFonts } = createField(new ExistingFont("Unknown", null));
    acroForm.setDefaultFont(latinFont);

    expect(resolveAppearanceFont(acroForm, field, "Hello")).toBe(latinFont);
    expect(availableFonts).toHaveBeenCalled();
  });

  it("preserves precedence of named, default-appearance, and available existing fonts", () => {
    const { pdf, field, acroForm } = createField(latinFont);
    const fontDict = new PdfDict([
      ["Type", PdfName.of("Font")],
      ["Subtype", PdfName.of("Type1")],
      ["BaseFont", PdfName.of("Helvetica")],
      ["Encoding", PdfName.of("WinAnsiEncoding")],
    ]);
    const fontRef = pdf.context.registry.register(fontDict);
    const resources = new PdfDict([
      [
        "Font",
        new PdfDict([
          ["Available", fontRef],
          ["Named", fontRef],
          ["DAFont", fontRef],
        ]),
      ],
    ]);
    const acroDict = pdf
      .getCatalog()
      .getDict("AcroForm", ref => pdf.context.registry.resolve(ref))!;
    acroDict.set("DR", resources);
    acroDict.set("DA", PdfString.fromString("/DAFont 12 Tf 0 g"));
    field.getDict().delete("DA");

    // An unusable explicit font must retain the existing resource lookup order.
    field.setFont(new ExistingFont("Unknown", null));
    expect(resolveAppearanceFont(acroForm, field, "Hello", "/Named")).toBe(
      acroForm.getExistingFont("/Named"),
    );
    expect(resolveAppearanceFont(acroForm, field, "Hello")).toBe(
      acroForm.getExistingFont("/DAFont"),
    );
    acroDict.set("DA", PdfString.fromString("/Missing 12 Tf 0 g"));
    expect(resolveAppearanceFont(acroForm, field, "Hello")).toBe(
      acroForm.getExistingFont("/Available"),
    );
  });

  it("returns the Helvetica fallback when no font is usable", () => {
    const { field, acroForm, availableFonts } = createField(latinFont);
    const result = resolveAppearanceFont(acroForm, field, "年月日");

    expect(result).toBeInstanceOf(ExistingFont);
    expect(result).toMatchObject({ name: "Helv" });
    expect(availableFonts).toHaveBeenCalled();
  });
});
