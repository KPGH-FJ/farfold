import { PPTX_LIMITS, PptxError, type PptxWorkerInput } from "./pptx_types";
import {
  PR,
  R,
  P,
  attr,
  children,
  parseXml,
  root,
  type PptxXml,
  type XmlBudget,
} from "./pptx_xml";

const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const MAIN =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
export interface PptxRelation {
  id: string;
  type: string;
  target: string;
  external: boolean;
}
function partName(name: string): void {
  if (
    !name ||
    name.length > 1024 ||
    /[\\:%\x00-\x1f\x7f]/.test(name) ||
    name.startsWith("/") ||
    name
      .replace(/\/$/, "")
      .split("/")
      .some((s) => !s || s === "." || s === "..")
  )
    throw new PptxError("invalid");
}
function resolvePart(from: string, target: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    throw new PptxError("invalid");
  }
  if (/[\\:#?\x00-\x1f\x7f]/.test(decoded)) throw new PptxError("invalid");
  const path = decoded.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const piece of decoded.split("/")) {
    if (!piece || piece === ".") continue;
    if (piece === "..") {
      if (!path.length) throw new PptxError("invalid");
      path.pop();
    } else path.push(piece);
  }
  const name = path.join("/");
  partName(name);
  return name;
}
export class PptxPackage {
  readonly parts = new Map<string, Uint8Array>();
  readonly entries = new Set<string>();
  readonly presentation: string;
  private parsed = new Map<string, PptxXml>();
  private relationsCache = new Map<string, PptxRelation[]>();
  private budget: XmlBudget = { nodes: 0, text: 0 };
  private contentTypes = new Map<string, string>();
  private defaults = new Map<string, string>();
  constructor(input: PptxWorkerInput) {
    if (
      !input ||
      !Array.isArray(input.entries) ||
      !Array.isArray(input.parts) ||
      !input.entries.length ||
      input.entries.length > PPTX_LIMITS.entries ||
      input.parts.length > PPTX_LIMITS.entries
    )
      throw new PptxError("limit");
    const folded = new Set<string>();
    for (const name of input.entries) {
      if (typeof name !== "string") throw new PptxError("invalid");
      partName(name);
      const canonical = name.replace(/\/$/, "").toLowerCase();
      if (folded.has(canonical)) throw new PptxError("invalid");
      folded.add(canonical);
      if (this.entries.has(name)) throw new PptxError("invalid");
      this.entries.add(name);
      if (/(^|\/)(vbaProject|activeX|embeddings)(\.|\/|$)/i.test(name))
        throw new PptxError("unsupported");
    }
    let total = 0;
    for (const part of input.parts) {
      if (
        !part ||
        typeof part.name !== "string" ||
        typeof part.data !== "string" ||
        !this.entries.has(part.name) ||
        this.parts.has(part.name)
      )
        throw new PptxError("invalid");
      if (part.data.length > Math.ceil(PPTX_LIMITS.part / 3) * 4)
        throw new PptxError("limit");
      if (
        part.data.length % 4 ||
        /[^A-Za-z0-9+/=]/.test(part.data) ||
        /=[^=]/.test(part.data) ||
        part.data.endsWith("===")
      )
        throw new PptxError("invalid");
      let value: string;
      try {
        value = atob(part.data);
      } catch {
        throw new PptxError("invalid");
      }
      total += value.length;
      if (total > PPTX_LIMITS.bytes || value.length > PPTX_LIMITS.part)
        throw new PptxError("limit");
      this.parts.set(
        part.name,
        Uint8Array.from(value, (c) => c.charCodeAt(0)),
      );
    }
    for (const name of this.entries)
      if (/\.(xml|rels)$/.test(name) && !this.parts.has(name))
        throw new PptxError("invalid");
    const types = this.xml("[Content_Types].xml");
    root(types, "Types", CT);
    for (const n of types.children) {
      if (n.uri !== CT || !["Override", "Default"].includes(n.name))
        throw new PptxError("unsupported");
      const type = attr(n, "ContentType", "");
      if (!type || /macroEnabled|vbaProject|activeX|oleObject/i.test(type))
        throw new PptxError("unsupported");
      if (n.name === "Override") {
        const raw = attr(n, "PartName", "");
        if (!raw?.startsWith("/")) throw new PptxError("invalid");
        const name = resolvePart("", raw);
        if (this.contentTypes.has(name) || !this.entries.has(name))
          throw new PptxError("invalid");
        this.contentTypes.set(name, type);
      } else {
        const extension = attr(n, "Extension", "")?.toLowerCase();
        if (!extension || this.defaults.has(extension))
          throw new PptxError("invalid");
        this.defaults.set(extension, type);
      }
    }
    // Inspect every relationship part, including inactive branches. Nothing is fetched.
    for (const name of this.parts.keys())
      if (name.endsWith(".rels")) this.readRelations(name);
    const documents = this.readRelations("_rels/.rels").filter(
      (r) => r.type === R + "/officeDocument",
    );
    if (documents.length !== 1 || documents[0].external)
      throw new PptxError("invalid");
    this.presentation = documents[0].target;
    if (this.mime(this.presentation) !== MAIN)
      throw new PptxError("unsupported");
    root(this.xml(this.presentation), "presentation", P);
  }
  mime(name: string): string | undefined {
    return (
      this.contentTypes.get(name) ??
      this.defaults.get(name.split(".").at(-1)!.toLowerCase())
    );
  }
  xml(name: string): PptxXml {
    const saved = this.parsed.get(name);
    if (saved) return saved;
    const bytes = this.parts.get(name);
    if (!bytes) throw new PptxError("invalid");
    const value = parseXml(bytes, this.budget);
    this.parsed.set(name, value);
    return value;
  }
  private readRelations(name: string): PptxRelation[] {
    const saved = this.relationsCache.get(name);
    if (saved) return saved;
    let source: string;
    if (name === "_rels/.rels") source = "";
    else {
      const match = name.match(/^(.*\/)?_rels\/([^/]+)\.rels$/);
      if (!match) throw new PptxError("invalid");
      source = (match[1] ?? "") + match[2];
    }
    const tree = this.xml(name);
    root(tree, "Relationships", PR);
    if (tree.children.some((n) => n.uri !== PR || n.name !== "Relationship"))
      throw new PptxError("unsupported");
    const ids = new Set<string>();
    const value = children(tree, "Relationship", PR).map((n) => {
      const id = attr(n, "Id", ""),
        type = attr(n, "Type", ""),
        raw = attr(n, "Target", ""),
        mode = attr(n, "TargetMode", "");
      if (
        !id ||
        !type ||
        raw === undefined ||
        ids.has(id) ||
        (mode !== undefined && mode !== "Internal" && mode !== "External")
      )
        throw new PptxError("invalid");
      if (
        /\/(aFChunk|afChunk|oleObject|package|vbaProject|control|attachedTemplate)$/.test(
          type,
        )
      )
        throw new PptxError("unsupported");
      ids.add(id);
      const external = mode === "External";
      if (external && type !== R + "/hyperlink")
        throw new PptxError("unsupported");
      return {
        id,
        type,
        target: external ? raw : resolvePart(source, raw),
        external,
      };
    });
    if (value.some((r) => !r.external && !this.entries.has(r.target)))
      throw new PptxError("invalid");
    this.relationsCache.set(name, value);
    return value;
  }
  relations(source: string): PptxRelation[] {
    const slash = source.lastIndexOf("/");
    const name =
      (slash < 0 ? "" : source.slice(0, slash + 1)) +
      "_rels/" +
      source.slice(slash + 1) +
      ".rels";
    return this.parts.has(name) ? this.readRelations(name) : [];
  }
  one(source: string, kind: string): string | undefined {
    const list = this.relations(source).filter(
      (r) => r.type === R + "/" + kind,
    );
    if (list.length > 1 || list.some((r) => r.external))
      throw new PptxError("invalid");
    return list[0]?.target;
  }
  relation(source: string, id: string): PptxRelation | undefined {
    return this.relations(source).find((r) => r.id === id);
  }
}
