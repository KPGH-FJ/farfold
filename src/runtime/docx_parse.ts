import { inspectDocxImage } from "./docx_images";
import { DocxPackage } from "./docx_package";
import { DocxStyles, type TextStyle, type Warn } from "./docx_styles";
import { DocxNumbering } from "./docx_numbering";
import { parseDocxTable } from "./docx_table";
import {
  DOCX_LIMITS,
  DocxError,
  type DocxBlock,
  type DocxDocument,
  type DocxImage,
  type DocxParagraph,
  type DocxRun,
  type DocxStory,
  type DocxWarningCode,
  type DocxWorkerInput,
} from "./docx_types";
import {
  A,
  MC,
  PIC,
  R,
  W,
  WP,
  attr,
  child,
  children,
  compatible,
  number,
  root,
  type DocxXml,
} from "./docx_xml";

interface StoryContext {
  source: string;
  fields: { result: boolean }[];
  depth: number;
  tableDepth: number;
}
/** Pure, bounded structure parsing. Actual image decoding happens in the Worker. */
export function parseDocx(input: DocxWorkerInput): DocxDocument {
  const pkg = new DocxPackage(input);
  const warningCounts = new Map<DocxWarningCode, number>();
  let partial = false,
    blockCount = 0,
    runCount = 0,
    cellCount = 0,
    outputText = 0;
  let pixels = 0,
    displayedPixels = 0,
    imageReferences = 0;
  const warn: Warn = (code, missing = false) => {
    warningCounts.set(code, (warningCounts.get(code) ?? 0) + 1);
    partial ||= missing;
  };
  warn("continuousLayout");
  const styles = new DocxStyles(pkg, warn),
    numbering = new DocxNumbering(pkg, warn);
  const images: DocxImage[] = [],
    imageByPart = new Map<string, DocxImage>();
  const stories: DocxStory[] = [],
    storyKeys = new Set<string>();
  const storyQueue: {
    kind: DocxStory["kind"];
    part: string;
    noteId?: string;
  }[] = [];
  const id = () => {
    if (++blockCount > DOCX_LIMITS.blocks) throw new DocxError("limit");
    return `block-${blockCount}`;
  };
  const countText = (s: string) => {
    outputText += s.length;
    if (outputText > DOCX_LIMITS.text) throw new DocxError("limit");
  };
  const notice = (code: DocxWarningCode): DocxRun => {
    warn(code, true);
    return { kind: "notice", code };
  };
  const queueStory = (
    kind: DocxStory["kind"],
    part: string,
    noteId?: string,
  ) => {
    const key = `${kind}\0${part}\0${noteId ?? ""}`;
    if (storyKeys.has(key)) return;
    if (storyKeys.size >= DOCX_LIMITS.blocks) throw new DocxError("limit");
    storyKeys.add(key);
    storyQueue.push({ kind, part, noteId });
  };
  const checkActive = (node: DocxXml) => {
    const stack = [node];
    while (stack.length) {
      const n = stack.pop()!;
      if (
        n.uri === W &&
        [
          "altChunk",
          "object",
          "subDoc",
          "ins",
          "del",
          "moveFrom",
          "moveTo",
          "pPrChange",
          "rPrChange",
          "tblPrChange",
          "tcPrChange",
          "trPrChange",
          "sectPrChange",
          "numberingChange",
        ].includes(n.name)
      )
        throw new DocxError("unsupported");
      const must = attr(n, "MustUnderstand", MC);
      if (
        must
          ?.trim()
          .split(/\s+/)
          .some((p) => ![W, R, A, WP, PIC].includes(n.namespaces[p]))
      )
        throw new DocxError("unsupported");
      for (const c of n.children) stack.push(c);
    }
  };
  const section = (n: DocxXml, ctx: StoryContext) => {
    for (const c of n.children) {
      if (c.uri !== W) {
        warn("sectionLayout");
        continue;
      }
      if (c.name === "headerReference" || c.name === "footerReference") {
        const key = attr(c, "id", R),
          rel = key && pkg.relation(ctx.source, key);
        const kind = c.name === "headerReference" ? "header" : "footer";
        if (!rel || rel.external || rel.type !== R + "/" + kind)
          throw new DocxError("invalid");
        queueStory(kind, rel.target);
      } else if (
        ![
          "pgSz",
          "pgMar",
          "titlePg",
          "type",
          "docGrid",
          "pgNumType",
          "footnotePr",
          "endnotePr",
        ].includes(c.name)
      )
        warn("sectionLayout");
    }
  };
  const image = (node: DocxXml, ctx: StoryContext): DocxRun => {
    const inline = child(node, "inline", WP);
    if (!inline || node.children.length !== 1)
      return notice("unsupportedDrawing");
    const extent = child(inline, "extent", WP),
      properties = child(inline, "docPr", WP);
    const graphic = child(inline, "graphic", A),
      data = graphic && child(graphic, "graphicData", A);
    const picture = data && child(data, "pic", PIC);
    if (!extent || !picture || attr(data!, "uri", "") !== PIC)
      return notice("unsupportedDrawing");
    const fill = child(picture, "blipFill", PIC),
      blip = child(fill, "blip", A);
    const sourceId = blip && (attr(blip, "embed", R) ?? attr(blip, "link", R));
    if (!sourceId) return notice("unsupportedImage");
    const shape = child(picture, "spPr", PIC);
    if (
      shape?.children.some(
        (n) =>
          n.uri !== A || !["xfrm", "prstGeom", "noFill", "ln"].includes(n.name),
      ) ||
      blip!.children.some((n) => n.uri !== A || n.name !== "extLst")
    )
      return notice("unsupportedDrawing");
    const line = child(shape, "ln", A);
    if (line && (line.children.length !== 1 || !child(line, "noFill", A)))
      return notice("unsupportedDrawing");
    const geometry = child(shape, "prstGeom", A);
    if (
      geometry &&
      (attr(geometry, "prst", "") !== "rect" ||
        child(geometry, "avLst", A)?.children.length)
    )
      return notice("unsupportedDrawing");
    if (blip!.children.length) warn("unsupportedFormatting");
    const crop = child(fill, "srcRect", A),
      transform = child(child(picture, "spPr", PIC), "xfrm", A);
    if (
      crop &&
      ["l", "t", "r", "b"].some(
        (k) => ![undefined, "0"].includes(attr(crop, k, "")),
      )
    )
      return notice("unsupportedDrawing");
    if (
      transform &&
      ["rot", "flipH", "flipV"].some(
        (k) => ![undefined, "0", "false"].includes(attr(transform, k, "")),
      )
    )
      return notice("unsupportedDrawing");
    const rel = pkg.relation(ctx.source, sourceId);
    if (!rel || rel.type !== R + "/image") return notice("missingImage");
    if (rel.external) return notice("externalImages");
    let saved = imageByPart.get(rel.target);
    if (!saved) {
      const bytes = pkg.parts.get(rel.target);
      if (!bytes)
        return notice(
          pkg.entries.has(rel.target) ? "unsupportedImage" : "missingImage",
        );
      if (
        bytes.length > DOCX_LIMITS.imageBytes ||
        images.length >= DOCX_LIMITS.images
      )
        throw new DocxError("limit");
      let info: ReturnType<typeof inspectDocxImage>;
      try {
        info = inspectDocxImage(bytes);
      } catch (error) {
        throw error instanceof DocxError ? error : new DocxError("invalid");
      }
      if (
        !["image/png", "image/jpeg"].includes(info.mimeType) ||
        pkg.mime(rel.target) !== info.mimeType
      )
        return notice("unsupportedImage");
      pixels += info.width * info.height;
      if (pixels > DOCX_LIMITS.imagePixels) throw new DocxError("limit");
      saved = {
        id: `image-${images.length + 1}`,
        mimeType: info.mimeType as "image/png" | "image/jpeg",
        bytes,
        width: info.width,
        height: info.height,
      };
      imageByPart.set(rel.target, saved);
      images.push(saved);
    }
    displayedPixels += saved.width * saved.height;
    if (
      ++imageReferences > DOCX_LIMITS.images ||
      displayedPixels > DOCX_LIMITS.imagePixels
    )
      throw new DocxError("limit");
    const widthPt = number(attr(extent, "cx", ""), 1, 20_116_800) / 12700;
    const heightPt = number(attr(extent, "cy", ""), 1, 20_116_800) / 12700;
    const alt = properties
      ? (attr(properties, "descr", "") ?? attr(properties, "title", "") ?? "")
      : "";
    countText(alt);
    return { kind: "image", imageId: saved.id, widthPt, heightPt, alt };
  };
  const visibleField = (ctx: StoryContext) => ctx.fields.every((f) => f.result);
  const inlineNodes = (
    nodes: DocxXml[],
    ctx: StoryContext,
    inherited: TextStyle,
    out: DocxRun[],
  ) => {
    if (++ctx.depth > DOCX_LIMITS.depth) throw new DocxError("limit");
    const push = (r: DocxRun) => {
      if (++runCount > DOCX_LIMITS.runs) throw new DocxError("limit");
      out.push(r);
    };
    for (const original of nodes)
      for (const n of compatible(original)) {
        if (n.uri !== W) throw new DocxError("unsupported");
        if (!["t", "instrText"].includes(n.name) && n.text.trim())
          throw new DocxError("invalid");
        if (n.name === "r") {
          const resolved = styles.run(child(n, "rPr"), inherited);
          inlineNodes(
            n.children.filter((c) => !(c.uri === W && c.name === "rPr")),
            ctx,
            resolved,
            out,
          );
        } else if (n.name === "fldChar") {
          const kind = attr(n, "fldCharType");
          if (kind === "begin") {
            if (ctx.fields.length >= DOCX_LIMITS.depth)
              throw new DocxError("limit");
            ctx.fields.push({ result: false });
            warn("cachedFields");
          } else if (kind === "separate") {
            const field = ctx.fields.at(-1);
            if (!field || field.result) throw new DocxError("invalid");
            field.result = true;
          } else if (kind === "end") {
            const field = ctx.fields.pop();
            if (!field) throw new DocxError("invalid");
            if (!field.result && visibleField(ctx))
              push(notice("missingFieldResult"));
          } else throw new DocxError("invalid");
        } else if (n.name === "instrText") {
          if (!ctx.fields.length) throw new DocxError("invalid");
        } else if (!visibleField(ctx)) {
          // Instructions are not output or evaluated; result text remains exact.
        } else if (n.name === "fldSimple") {
          warn("cachedFields");
          if (!n.children.length) push(notice("missingFieldResult"));
          else inlineNodes(n.children, ctx, inherited, out);
        } else if (n.name === "hyperlink") {
          warn("hyperlinks");
          inlineNodes(n.children, ctx, inherited, out);
        } else if (inherited.hidden || inherited.webHidden) {
          if (
            [
              "t",
              "tab",
              "br",
              "cr",
              "drawing",
              "footnoteReference",
              "endnoteReference",
            ].includes(n.name)
          )
            push(notice("hiddenContent"));
          else if (
            ![
              "bookmarkStart",
              "bookmarkEnd",
              "proofErr",
              "lastRenderedPageBreak",
            ].includes(n.name)
          )
            throw new DocxError("unsupported");
        } else {
          const style = { ...inherited };
          delete style.hidden;
          delete style.webHidden;
          switch (n.name) {
            case "t": {
              if (n.children.length) throw new DocxError("unsupported");
              countText(n.text);
              push({ kind: "text", text: n.text, style });
              break;
            }
            case "tab":
              push({ kind: "tab" });
              break;
            case "br":
            case "cr": {
              const type = attr(n, "type");
              if (type === "column") warn("sectionLayout");
              push({
                kind: "break",
                ...(type === "page" ? { page: true } : {}),
              });
              break;
            }
            case "drawing":
              push(image(n, ctx));
              break;
            case "footnoteReference":
            case "endnoteReference": {
              const noteId = attr(n, "id"),
                kind = n.name === "footnoteReference" ? "footnote" : "endnote";
              const path = pkg.one(pkg.document, kind + "s");
              if (!noteId || !/^-?\d+$/.test(noteId) || !path)
                throw new DocxError("invalid");
              queueStory(kind, path, noteId);
              push({
                kind: "noteReference",
                noteKind: kind,
                noteId,
                style: { ...style, verticalAlign: "superscript" },
              });
              break;
            }
            case "noBreakHyphen":
              push({ kind: "text", text: "\u2011", style });
              break;
            case "softHyphen":
              push({ kind: "text", text: "\u00ad", style });
              break;
            case "pict":
            case "sym":
            case "ruby":
            case "contentPart":
            case "sdt":
              push(notice("unsupportedContent"));
              break;
            case "commentReference":
              warn("comments", true);
              push({ kind: "notice", code: "comments" });
              break;
            case "commentRangeStart":
            case "commentRangeEnd":
              warn("comments", true);
              break;
            case "bookmarkStart":
            case "bookmarkEnd":
            case "proofErr":
            case "lastRenderedPageBreak":
            case "footnoteRef":
            case "endnoteRef":
            case "separator":
            case "continuationSeparator":
            case "permStart":
            case "permEnd":
              break;
            default:
              throw new DocxError("unsupported");
          }
        }
      }
    ctx.depth--;
  };
  const parseBlocks = (nodes: DocxXml[], ctx: StoryContext): DocxBlock[] => {
    if (++ctx.depth > DOCX_LIMITS.depth) throw new DocxError("limit");
    const result: DocxBlock[] = [];
    for (const original of nodes)
      for (const n of compatible(original)) {
        if (n.uri !== W) throw new DocxError("unsupported");
        if (n.name === "p") {
          const props = child(n, "pPr"),
            resolved = styles.paragraph(props),
            p: DocxParagraph = {
              kind: "paragraph",
              id: id(),
              source: pkg.source(ctx.source, n),
              runs: [],
              style: resolved.paragraph,
            };
          if (resolved.headingLevel) p.headingLevel = resolved.headingLevel;
          if (resolved.numbering)
            p.list = {
              level: resolved.numbering.level,
              label: numbering.next(
                ctx.source,
                resolved.numbering.id,
                resolved.numbering.level,
              ),
            };
          if (child(props, "pageBreakBefore")) warn("sectionLayout");
          if (child(props, "sectPr")) section(child(props, "sectPr")!, ctx);
          inlineNodes(
            n.children.filter((c) => !(c.uri === W && c.name === "pPr")),
            ctx,
            resolved.text,
            p.runs,
          );
          if (n.text.trim()) throw new DocxError("invalid");
          result.push(p);
        } else if (n.name === "tbl") {
          if (++ctx.tableDepth > DOCX_LIMITS.tableDepth)
            throw new DocxError("limit");
          result.push(
            parseDocxTable(
              n,
              id(),
              pkg.source(ctx.source, n),
              styles,
              warn,
              (items) => parseBlocks(items, ctx),
              () => {
                if (++cellCount > DOCX_LIMITS.cells)
                  throw new DocxError("limit");
              },
            ),
          );
          ctx.tableDepth--;
        } else if (n.name === "sectPr") section(n, ctx);
        else if (
          [
            "bookmarkStart",
            "bookmarkEnd",
            "proofErr",
            "permStart",
            "permEnd",
          ].includes(n.name)
        ) {
          /* Inert markers have no body text. */
        } else if (["sdt", "customXml"].includes(n.name)) {
          warn("unsupportedContent", true);
          result.push({ kind: "notice", id: id(), code: "unsupportedContent" });
        } else throw new DocxError("unsupported");
      }
    ctx.depth--;
    return result;
  };
  const parseStory = (nodes: DocxXml[], source: string): DocxBlock[] => {
    const context: StoryContext = {
      source,
      fields: [],
      depth: 0,
      tableDepth: 0,
    };
    const result = parseBlocks(nodes, context);
    if (context.fields.length) throw new DocxError("invalid");
    return result;
  };
  const doc = pkg.xml(pkg.document);
  checkActive(doc);
  const body = child(doc, "body");
  if (
    !body ||
    doc.children.some(
      (n) => n.uri !== W || !["body", "background"].includes(n.name),
    )
  )
    throw new DocxError("unsupported");
  if (child(doc, "background")) warn("unsupportedFormatting");
  if (doc.text.trim() || body.text.trim()) throw new DocxError("invalid");
  const blocks = parseStory(body.children, pkg.document);
  for (let i = 0; i < storyQueue.length; i++) {
    const item = storyQueue[i],
      tree = pkg.xml(item.part);
    checkActive(tree);
    let storyNodes: DocxXml[];
    if (item.kind === "header" || item.kind === "footer") {
      root(tree, item.kind === "header" ? "hdr" : "ftr");
      storyNodes = tree.children;
    } else {
      root(tree, item.kind + "s");
      const notes = children(tree, item.kind).filter(
        (n) => attr(n, "id") === item.noteId,
      );
      if (notes.length !== 1) throw new DocxError("invalid");
      storyNodes = notes[0].children;
    }
    stories.push({
      id: `story-${i + 1}`,
      kind: item.kind,
      ...(item.noteId ? { noteId: item.noteId } : {}),
      blocks: parseStory(storyNodes, item.part),
    });
  }
  return {
    blocks,
    stories,
    images,
    warnings: [...warningCounts].map(([code, count]) => ({ code, count })),
    partial,
  };
}
