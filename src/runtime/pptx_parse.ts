import { PptxPackage } from "./pptx_package";
import {
  PptxError,
  PPTX_LIMITS as L,
  PPTX_GEOMETRY_LIMITS as G,
  type PptxDocument,
  type PptxSlide,
  type PptxWarning,
  type PptxWarningCode,
  type PptxWorkerInput,
} from "./pptx_types";
import { A, P, R, attr, child, children, root, type PptxXml } from "./pptx_xml";
import {
  colorMap,
  matrixStyle,
  readColor,
  readTheme,
  type PptxTheme,
} from "./pptx_theme";
import {
  emu,
  flag,
  hiddenShape,
  inheritance,
  layer,
  placeholder,
  type PptxLayer,
} from "./pptx_layout";
import { PptxImages } from "./pptx_images";
import { shape, type PptxShapeContext } from "./pptx_shapes";

export function parsePptx(input: PptxWorkerInput): PptxDocument {
  const pkg = new PptxPackage(input),
    presentation = pkg.xml(pkg.presentation),
    size = child(presentation, "sldSz", P);
  if (!size) throw new PptxError("invalid");
  const width = emu(attr(size, "cx"), G.slideMin, G.slideMax),
    height = emu(attr(size, "cy"), G.slideMin, G.slideMax);
  if (width * height > G.slidePixels) throw new PptxError("limit");
  const ids = child(presentation, "sldIdLst", P);
  if (!ids) throw new PptxError("invalid");
  const order = children(ids, "sldId", P);
  if (!order.length || order.length > G.slides) throw new PptxError("limit");
  if (order.length !== ids.children.length) throw new PptxError("unsupported");
  const imageStore = new PptxImages(pkg),
    warnings: PptxWarning[] = [],
    warningIndex = new Map<string, PptxWarning>();
  let shapeCount = 0,
    runCount = 0,
    textCount = 0;
  const warn = (code: PptxWarningCode, slideId?: string) => {
    const key = code + ":" + (slideId ?? "");
    const existing = warningIndex.get(key);
    if (existing) existing.count++;
    else {
      const w = { code, count: 1, ...(slideId ? { slideId } : {}) };
      warnings.push(w);
      warningIndex.set(key, w);
    }
  };
  const slides: PptxSlide[] = [],
    seenIds = new Set<string>(),
    seenParts = new Set<string>();
  const layers = new Map<string, PptxLayer>(),
    themes = new Map<string, PptxTheme>();
  const getLayer = (part: string, kind: string): PptxLayer => {
    const mime: Record<string, string> = {
      sld: "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
      sldLayout:
        "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml",
      sldMaster:
        "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml",
    };
    if (pkg.mime(part) !== mime[kind]) throw new PptxError("unsupported");
    const saved = layers.get(part);
    if (saved) return saved;
    const node = pkg.xml(part);
    root(node, kind, P);
    const result = layer(part, node);
    layers.set(part, result);
    return result;
  };
  for (const entry of order) {
    const id = attr(entry, "id"),
      rid = attr(entry, "id", R),
      rel = rid && pkg.relation(pkg.presentation, rid);
    if (
      !id ||
      !/^\d+$/.test(id) ||
      seenIds.has(id) ||
      !rel ||
      rel.external ||
      rel.type !== R + "/slide" ||
      seenParts.has(rel.target)
    )
      throw new PptxError("invalid");
    seenIds.add(id);
    seenParts.add(rel.target);
    const slide = getLayer(rel.target, "sld");
    if (!flag(attr(slide.node, "show"), true)) {
      warn("hiddenContent");
      continue;
    }
    const layoutPart = pkg.one(slide.part, "slideLayout"),
      layout = layoutPart ? getLayer(layoutPart, "sldLayout") : undefined;
    const masterPart = layout && pkg.one(layout.part, "slideMaster"),
      master = masterPart ? getLayer(masterPart, "sldMaster") : undefined;
    // Theme overrides alter the effective palette/font/style matrix. Until
    // resolved explicitly they cannot be treated as the unchanged master.
    for (const l of [slide, layout, master])
      if (l) {
        if (pkg.one(l.part, "themeOverride"))
          throw new PptxError("unsupported");
        for (const n of l.node.children)
          if (
            n.uri !== P ||
            ![
              "cSld",
              "clrMap",
              "clrMapOvr",
              "sldLayoutIdLst",
              "txStyles",
              "hf",
            ].includes(n.name)
          )
            throw new PptxError("unsupported");
        if (child(l.node, "hf", P)) throw new PptxError("unsupported");
        const common = child(l.node, "cSld", P);
        if (
          common?.children.some(
            (n) => n.uri !== P || !["bg", "spTree"].includes(n.name),
          )
        )
          throw new PptxError("unsupported");
      }
    const themePart =
      (master && pkg.one(master.part, "theme")) ??
      pkg.one(pkg.presentation, "theme");
    let theme: PptxTheme = { colors: new Map(), fonts: new Map() };
    if (themePart) {
      if (
        pkg.mime(themePart) !==
        "application/vnd.openxmlformats-officedocument.theme+xml"
      )
        throw new PptxError("unsupported");
      theme = themes.get(themePart) ?? readTheme(pkg.xml(themePart));
      themes.set(themePart, theme);
    }
    const mapping = colorMap(master?.node, layout?.node, slide.node);
    const c: PptxShapeContext = {
      pkg,
      images: imageStore,
      theme,
      mapping,
      master: master?.node,
      defaults: [],
      warn: (code) => warn(code, id),
      run: (text) => {
        if (++runCount > L.runs || (textCount += text?.length ?? 0) > L.text)
          throw new PptxError("limit");
      },
    };
    const d = child(presentation, "defaultTextStyle", P);
    if (d) c.defaults.push(d);
    let background = theme.colors.get(mapping.bg1 ?? "lt1") ?? "#FFFFFF";
    for (const l of [master, layout, slide]) {
      const bg = child(child(l?.node, "cSld", P), "bg", P);
      if (!bg) continue;
      const direct = child(bg, "bgPr", P),
        reference = child(bg, "bgRef", P);
      if (!!direct === !!reference) throw new PptxError("invalid");
      if (direct) {
        if (
          direct.children.some(
            (n) =>
              n.uri !== A ||
              (n.name !== "solidFill" &&
                !(n.name === "effectLst" && !n.children.length)),
          )
        )
          throw new PptxError("unsupported");
        const solid = child(direct, "solidFill");
        if (!solid) throw new PptxError("unsupported");
        background = readColor(solid, theme, mapping);
      } else if (reference) {
        const style = matrixStyle(reference, "bgFillStyleLst", theme);
        if (!style || style.name !== "solidFill")
          throw new PptxError("unsupported");
        background = readColor(
          style,
          theme,
          mapping,
          readColor(reference, theme, mapping),
        );
      }
    }
    const result: PptxSlide = { id, part: slide.part, background, shapes: [] };
    const add = (l: PptxLayer, kind: "master" | "layout" | "slide") => {
      for (const s of l.shapes) {
        if (kind !== "slide" && placeholder(s)) continue;
        if (hiddenShape(s)) {
          warn("hiddenContent", id);
          continue;
        }
        if (++shapeCount > L.shapes) throw new PptxError("limit");
        const chain =
          kind === "slide"
            ? inheritance(s, layout, master)
            : kind === "layout"
              ? inheritance(s, undefined, master)
              : [s];
        result.shapes.push(shape(chain, l.part, kind, c));
      }
    };
    if (
      master &&
      flag(attr(slide.node, "showMasterSp"), true) &&
      flag(layout && attr(layout.node, "showMasterSp"), true)
    )
      add(master, "master");
    if (layout) add(layout, "layout");
    add(slide, "slide");
    let displayPixels = 0;
    for (const s of result.shapes)
      if (s.kind === "image") {
        const image = imageStore.images.get(s.imageId)!;
        displayPixels += image.width * image.height;
      }
    if (displayPixels > L.imagePixels) throw new PptxError("limit");
    slides.push(result);
  }
  if (!slides.length) throw new PptxError("unsupported");
  return {
    width,
    height,
    slides,
    images: [...imageStore.images.values()],
    warnings,
    partial: warnings.some((w) =>
      ["unsupportedFormatting", "unsupportedContent", "hiddenContent"].includes(
        w.code,
      ),
    ),
  };
}
