import { PDF } from "#src/api/pdf";
import { AppearanceGenerator } from "#src/document/forms/appearance-generator";
import { TerminalField } from "#src/document/forms/fields";
import { loadFixture } from "#src/test-utils";
import { PDFDocument, PDFName } from "pdf-lib";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

it.each(["text", "dropdown", "listbox", "button"] as const)(
  "flattens a %s field with an explicit font without parsing an unused Type1 resource",
  async kind => {
    const template = await PDFDocument.create();
    const page = template.addPage([595, 842]);
    const templateForm = template.getForm();
    const rect = { x: 30, y: 700, width: 300, height: 40 };

    switch (kind) {
      case "text": {
        const field = templateForm.createTextField("field");
        field.setText("Hello");
        field.addToPage(page, rect);
        break;
      }
      case "dropdown": {
        const field = templateForm.createDropdown("field");
        field.addOptions(["Hello"]);
        field.select("Hello");
        field.addToPage(page, rect);
        break;
      }
      case "listbox": {
        const field = templateForm.createOptionList("field");
        field.addOptions(["Hello"]);
        field.select("Hello");
        field.addToPage(page, rect);
        break;
      }
      case "button": {
        const field = templateForm.createButton("field");
        field.addToPage("Hello", page, rect);
        break;
      }
    }

    // Deliberately unreadable bytes expose parsing of an unused resource.
    const program = new TextEncoder().encode("synthetic unreadable Type1 font");
    const fontFile = template.context.register(
      template.context.stream(program, { Length1: program.length }),
    );
    const descriptor = template.context.register(
      template.context.obj({
        Type: "FontDescriptor",
        FontName: "UnusedSyntheticType1",
        Flags: 32,
        FontBBox: [0, 0, 1000, 1000],
        ItalicAngle: 0,
        Ascent: 800,
        Descent: -200,
        CapHeight: 700,
        StemV: 80,
        FontFile: fontFile,
      }),
    );
    const fallback = template.context.register(
      template.context.obj({
        Type: "Font",
        Subtype: "Type1",
        BaseFont: "UnusedSyntheticType1",
        FirstChar: 32,
        LastChar: 32,
        Widths: [500],
        Encoding: "WinAnsiEncoding",
        FontDescriptor: descriptor,
      }),
    );
    templateForm.acroForm.dict.set(
      PDFName.of("DR"),
      template.context.obj({ Font: { UnusedSyntheticType1: fallback } }),
    );

    const pdf = await PDF.load(await template.save());
    const form = pdf.getForm()!;
    const font = pdf.embedFont(await loadFixture("fonts", "ttf/LiberationSans-Regular.ttf"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const field = form.getField("field");

    if (!(field instanceof TerminalField)) {
      throw new Error("Expected a terminal form field");
    }

    field.setFont(font);

    // Buttons preserve authored appearances during flattening; explicitly
    // exercise the shared resolver through the button appearance generator.
    if (kind === "button") {
      const generator = new AppearanceGenerator(form.acroForm(), pdf.context.registry);
      const button = form.getButton("field")!;

      for (const widget of button.getWidgets()) {
        widget.setNormalAppearance(generator.generateButtonAppearance(button, widget));
      }
    }

    form.flatten({ regenerateAppearances: true });
    const bytes = await pdf.save();

    expect(warning).not.toHaveBeenCalled();
    const saved = await PDFDocument.load(bytes);
    expect(saved.getPageCount()).toBe(1);
    expect(saved.getForm().getFields()).toHaveLength(0);
    const reloaded = await PDF.load(bytes);
    expect(reloaded.getPage(0)!.extractText().text).toContain("Hello");
  },
);
