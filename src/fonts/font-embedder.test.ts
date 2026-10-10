import type { PdfDict } from "#src/objects/pdf-dict";
import { PdfRef } from "#src/objects/pdf-ref";
import { PdfStream } from "#src/objects/pdf-stream";
import { loadFixture } from "#src/test-utils";
import { describe, expect, it } from "vitest";

import { EmbeddedFont } from "./embedded-font";
import {
  createFontObjects,
  createFontObjectsFull,
  generateSubsetTag,
  registerFontObjects,
} from "./font-embedder";
import { parseToUnicode } from "./to-unicode";

describe("generateSubsetTag", () => {
  it("should generate 6 uppercase letters", () => {
    const tag = generateSubsetTag();
    expect(tag).toMatch(/^[A-Z]{6}$/);
  });

  it("should generate different tags", () => {
    const tags = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tags.add(generateSubsetTag());
    }
    // With 26^6 possibilities, 100 samples should all be unique
    expect(tags.size).toBe(100);
  });
});

describe("createFontObjects", () => {
  it("should create all required PDF objects", async () => {
    const fontBytes = await loadFixture("fonts", "ttf/LiberationSans-Regular.ttf");
    const font = EmbeddedFont.fromBytes(fontBytes);

    // Encode some text to track glyph usage
    font.encodeText("Hello World");

    const result = createFontObjects(font, { subsetTag: "ABCDEF" });

    // Check Type0 dict
    expect(result.type0Dict.getName("Type")?.value).toBe("Font");
    expect(result.type0Dict.getName("Subtype")?.value).toBe("Type0");
    expect(result.type0Dict.getName("Encoding")?.value).toBe("Identity-H");
    expect(result.type0Dict.getName("BaseFont")?.value).toContain("ABCDEF+");

    // Check CIDFont dict
    expect(result.cidFontDict.getName("Type")?.value).toBe("Font");
    expect(result.cidFontDict.getName("Subtype")?.value).toBe("CIDFontType2");
    // CIDToGIDMap is now a stream for subsetted TTF fonts (set during registration)
    // So we check that the stream exists in the result
    expect(result.cidToGidMapStream).toBeInstanceOf(PdfStream);
    expect(result.cidFontDict.has("W")).toBe(true);

    // Check CIDSystemInfo
    const cidSystemInfo = result.cidFontDict.get("CIDSystemInfo") as PdfDict;
    expect(cidSystemInfo.getString("Registry")?.asString()).toBe("Adobe");
    expect(cidSystemInfo.getString("Ordering")?.asString()).toBe("Identity");

    // Check FontDescriptor
    expect(result.descriptorDict.getName("Type")?.value).toBe("FontDescriptor");
    expect(result.descriptorDict.has("FontBBox")).toBe(true);
    expect(result.descriptorDict.has("Ascent")).toBe(true);
    expect(result.descriptorDict.has("Descent")).toBe(true);
    expect(result.descriptorDict.has("Flags")).toBe(true);

    // Check streams
    expect(result.fontStream).toBeInstanceOf(PdfStream);
    expect(result.fontStream.data.length).toBeGreaterThan(0);
    expect(result.toUnicodeStream).toBeInstanceOf(PdfStream);
    expect(result.toUnicodeStream.data.length).toBeGreaterThan(0);
  });

  it("should set subset tag on font", async () => {
    const fontBytes = await loadFixture("fonts", "ttf/LiberationSans-Regular.ttf");
    const font = EmbeddedFont.fromBytes(fontBytes);

    font.encodeText("Test");

    createFontObjects(font, { subsetTag: "XYZABC" });

    expect(font.subsetTag).toBe("XYZABC");
    expect(font.baseFontName).toContain("XYZABC+");
  });

  it("should include font metrics in descriptor", async () => {
    const fontBytes = await loadFixture("fonts", "ttf/LiberationSans-Regular.ttf");
    const font = EmbeddedFont.fromBytes(fontBytes);

    font.encodeText("ABC");

    const result = createFontObjects(font);

    const ascent = result.descriptorDict.getNumber("Ascent")?.value;
    const descent = result.descriptorDict.getNumber("Descent")?.value;

    expect(ascent).toBeGreaterThan(0);
    expect(descent).toBeLessThan(0);
  });

  it("should generate ToUnicode CMap", async () => {
    const fontBytes = await loadFixture("fonts", "ttf/LiberationSans-Regular.ttf");
    const font = EmbeddedFont.fromBytes(fontBytes);

    font.encodeText("Hi");

    const result = createFontObjects(font);

    const toUnicodeData = result.toUnicodeStream.data;
    const text = new TextDecoder().decode(toUnicodeData);

    expect(text).toContain("begincmap");
    expect(text).toContain("endcmap");
    expect(text).toContain("begincodespacerange");
  });
});

describe("createFontObjectsFull", () => {
  it("retains used Japanese mappings while embedding the complete font", async () => {
    const fontBytes = await loadFixture("fonts", "ttf/NotoSansJP-Regular.ttf");
    const font = EmbeddedFont.fromBytes(fontBytes);
    font.encodeText("2026年9月16日");

    const result = createFontObjectsFull(font);
    const toUnicode = parseToUnicode(result.toUnicodeStream.data);

    for (const character of "年月日") {
      const gid = font.program.getGlyphId(character.codePointAt(0)!);
      expect(gid).toBeGreaterThan(0);
      expect(toUnicode.get(gid)).toBe(character);
    }

    expect(result.fontStream.data).toEqual(fontBytes);
    expect(result.type0Dict.getName("BaseFont")?.value).toBe(font.program.postScriptName);
    expect(result.cidFontDict.getName("CIDToGIDMap")?.value).toBe("Identity");
  });

  it("keeps default-range mappings for unused characters", async () => {
    const fontBytes = await loadFixture("fonts", "ttf/LiberationSans-Regular.ttf");
    const font = EmbeddedFont.fromBytes(fontBytes);
    const result = createFontObjectsFull(font);
    const toUnicode = parseToUnicode(result.toUnicodeStream.data);

    for (const character of "ABC123") {
      expect(toUnicode.get(font.program.getGlyphId(character.codePointAt(0)!))).toBe(character);
    }
  });

  it("prefers the tracked Unicode value when code points share a glyph", async () => {
    const fontBytes = await loadFixture("fonts", "ttf/NotoSansJP-Regular.ttf");
    const font = EmbeddedFont.fromBytes(fontBytes);
    const gid = font.program.getGlyphId(0x00a0);
    expect(gid).toBe(font.program.getGlyphId(0x0020));
    font.encodeText("\u00a0 ");

    const result = createFontObjectsFull(font);
    const toUnicode = parseToUnicode(result.toUnicodeStream.data);

    expect(toUnicode.get(gid)).toBe("\u00a0");
  });

  it("retains used supplementary-plane mappings as surrogate pairs", async () => {
    const fontBytes = await loadFixture("fonts", "ttf/DejaVuSans.ttf");
    const font = EmbeddedFont.fromBytes(fontBytes);
    font.encodeText("😀");
    const gid = font.program.getGlyphId(0x1f600);
    expect(gid).toBeGreaterThan(0);

    const result = createFontObjectsFull(font);
    const toUnicode = parseToUnicode(result.toUnicodeStream.data);

    expect(toUnicode.get(gid)).toBe("😀");
    expect(new TextDecoder().decode(result.toUnicodeStream.data)).toContain("<D83DDE00>");
  });
});

describe("registerFontObjects", () => {
  it("should register all objects and return type0 ref", async () => {
    const fontBytes = await loadFixture("fonts", "ttf/LiberationSans-Regular.ttf");
    const font = EmbeddedFont.fromBytes(fontBytes);

    font.encodeText("Test");

    const result = createFontObjects(font);

    // Mock register function
    let nextObjNum = 1;
    const registeredObjects: Array<{ ref: PdfRef; obj: PdfDict | PdfStream }> = [];

    const register = (obj: PdfDict | PdfStream): PdfRef => {
      const ref = PdfRef.of(nextObjNum++, 0);
      registeredObjects.push({ ref, obj });
      return ref;
    };

    const type0Ref = registerFontObjects(result, register);

    // Should have registered 6 objects (fontStream, toUnicode, cidToGidMap, descriptor, cidFont, type0)
    expect(registeredObjects.length).toBe(6);

    // Type0 should be the last registered (highest object number)
    expect(type0Ref.objectNumber).toBe(6);

    // Check that references were linked correctly
    // Type0 should have DescendantFonts array
    expect(result.type0Dict.has("DescendantFonts")).toBe(true);
    expect(result.type0Dict.has("ToUnicode")).toBe(true);

    // CIDFont should have FontDescriptor ref
    expect(result.cidFontDict.has("FontDescriptor")).toBe(true);

    // FontDescriptor should have FontFile2 ref
    expect(result.descriptorDict.has("FontFile2")).toBe(true);
  });
});
