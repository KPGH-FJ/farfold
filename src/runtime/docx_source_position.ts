import {
  DOCX_LIMITS as L,
  DocxError,
  type DocxSourcePosition,
} from "./docx_types";
import type { DocxXml } from "./docx_xml";

export const DOCX_SOURCE_LIMITS = {
  partLength: 1024,
  depth: L.depth - 1,
  index: L.nodes - 1,
  indices: L.blocks * (L.depth - 1),
  partBytes: L.text,
} as const;

/** Package-relative file part, never an external URL or directory. */
export function isDocxSourcePart(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= DOCX_SOURCE_LIMITS.partLength &&
    !/[\\:%\x00-\x1f\x7f]/.test(value) &&
    !value.split("/").some((part) => !part || part === "." || part === "..")
  );
}

/** Shape only: this does not establish current preview or XML membership. */
export function isDocxSourcePosition(
  value: unknown,
): value is DocxSourcePosition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return (
    Object.keys(source).length === 2 &&
    Object.keys(source).every(
      (key) => key === "part" || key === "elementPath",
    ) &&
    isDocxSourcePart(source.part) &&
    Array.isArray(source.elementPath) &&
    source.elementPath.length > 0 &&
    source.elementPath.length <= DOCX_SOURCE_LIMITS.depth &&
    Array.from(source.elementPath).every(
      (index) =>
        Number.isSafeInteger(index) &&
        index >= 0 &&
        index <= DOCX_SOURCE_LIMITS.index,
    )
  );
}

/** Bound repeated coordinates independently from document body text. */
export class DocxSourceBudget {
  private indices = 0;
  private bytes = 0;
  add(source: DocxSourcePosition): void {
    this.indices += source.elementPath.length;
    this.bytes += new TextEncoder().encode(source.part).length;
    if (
      this.indices > DOCX_SOURCE_LIMITS.indices ||
      this.bytes > DOCX_SOURCE_LIMITS.partBytes
    )
      throw new DocxError("limit");
  }
}

type Link = { part: string; parent: DocxXml | null; index: number };
/** Original element ancestry. A full path is copied only for emitted blocks. */
export class DocxSourcePositions {
  private roots = new Map<string, DocxXml>();
  private links = new WeakMap<DocxXml, Link>();
  private nodes = 0;
  private budget = new DocxSourceBudget();

  position(part: string, root: DocxXml, node: DocxXml): DocxSourcePosition {
    if (!isDocxSourcePart(part)) throw new DocxError("invalid");
    const existing = this.roots.get(part);
    if (existing && existing !== root) throw new DocxError("invalid");
    if (!existing) {
      const visit = (
        current: DocxXml,
        parent: DocxXml | null,
        index: number,
        depth: number,
      ) => {
        if (depth > DOCX_SOURCE_LIMITS.depth || ++this.nodes > L.nodes)
          throw new DocxError("limit");
        if (this.links.has(current)) throw new DocxError("invalid");
        this.links.set(current, { part, parent, index });
        current.children.forEach((child, at) =>
          visit(child, current, at, depth + 1),
        );
      };
      visit(root, null, 0, 0);
      this.roots.set(part, root);
    }
    const elementPath: number[] = [];
    let current = node;
    while (current !== root) {
      const link = this.links.get(current);
      if (!link || link.part !== part || !link.parent)
        throw new DocxError("invalid");
      elementPath.push(link.index);
      if (elementPath.length > DOCX_SOURCE_LIMITS.depth)
        throw new DocxError("limit");
      current = link.parent;
    }
    const source = { part, elementPath: Object.freeze(elementPath.reverse()) };
    if (!isDocxSourcePosition(source)) throw new DocxError("invalid");
    this.budget.add(source);
    return Object.freeze(source);
  }
}
