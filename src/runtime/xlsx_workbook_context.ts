import { xstring } from "./xlsx_xstring";
import { richText, type SharedText } from "./xlsx_sheet";
import { parseStyles, themeColors } from "./xlsx_styles";
import {
  attr,
  boolean,
  child,
  children,
  PACKAGE_REL_NS,
  REL_NS,
  parseXml,
  requireRoot,
  type XmlNode,
  type XmlBudget,
} from "./xlsx_xml";
import {
  XLSX_LIMITS,
  XlsxError,
  type XlsxSheetInfo,
  type XlsxStyle,
  type XlsxWorkerInput,
} from "./xlsx_types";

const CONTENT_NS =
  "http://schemas.openxmlformats.org/package/2006/content-types";
export interface WorkbookRelation {
  id: string;
  type: string;
  target: string;
  external: boolean;
}
const asciiLower = (value: string) =>
  value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
function partName(name: string): void {
  if (
    !name ||
    name.length > 1024 ||
    /[\\:%\x00-\x1f\x7f]/.test(name) ||
    name.startsWith("/") ||
    name
      .replace(/\/$/, "")
      .split("/")
      .some((p) => !p || p === "." || p === "..")
  )
    throw new XlsxError("invalid");
}
export function resolveWorkbookPart(from: string, target: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    throw new XlsxError("invalid");
  }
  if (/[\\:#?\x00-\x1f\x7f]/.test(decoded)) throw new XlsxError("invalid");
  const result = decoded.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const piece of decoded.split("/")) {
    if (piece === "." || piece === "") continue;
    if (piece === "..") {
      if (!result.length) throw new XlsxError("invalid");
      result.pop();
    } else result.push(piece);
  }
  const name = result.join("/");
  partName(name);
  return name;
}
export interface WorkbookContext {
  entries: Set<string>;
  read: (name: string) => XmlNode;
  relations: (source: string) => WorkbookRelation[];
  warnings: Set<string>;
  workbook: XmlNode;
  sheetParts: Map<string, string>;
  sheets: XlsxSheetInfo[];
  date1904: boolean;
  styles: XlsxStyle[];
  styleRoot: XmlNode | undefined;
  sharedRoot: XmlNode | undefined;
  strings: SharedText[];
  themes: (string | undefined)[];
}
export function workbookContext(
  input: XlsxWorkerInput,
  aggregate = false,
): WorkbookContext {
  if (
    !input ||
    !Array.isArray(input.parts) ||
    !Array.isArray(input.entries) ||
    input.entries.length > XLSX_LIMITS.parts ||
    input.parts.length > XLSX_LIMITS.parts
  )
    throw new XlsxError("limit");
  const entries = new Set<string>();
  for (const name of input.entries) {
    if (typeof name !== "string") throw new XlsxError("invalid");
    partName(name);
    if (entries.has(name)) throw new XlsxError("invalid");
    entries.add(name);
  }
  const parts = new Map<string, Uint8Array>();
  let total = 0;
  for (const part of input.parts) {
    if (
      !part ||
      typeof part.name !== "string" ||
      typeof part.data !== "string" ||
      !entries.has(part.name) ||
      parts.has(part.name)
    )
      throw new XlsxError("invalid");
    if (part.data.length > Math.ceil(XLSX_LIMITS.partBytes / 3) * 4)
      throw new XlsxError("limit");
    if (
      part.data.length % 4 !== 0 ||
      /[^A-Za-z0-9+/=]/.test(part.data) ||
      /=[^=]/.test(part.data) ||
      part.data.endsWith("===")
    )
      throw new XlsxError("invalid");
    const raw = atob(part.data);
    total += raw.length;
    if (total > XLSX_LIMITS.bytes || raw.length > XLSX_LIMITS.partBytes)
      throw new XlsxError("limit");
    parts.set(
      part.name,
      Uint8Array.from(raw, (c) => c.charCodeAt(0)),
    );
  }
  for (const name of entries)
    if ((name.endsWith(".xml") || name.endsWith(".rels")) && !parts.has(name))
      throw new XlsxError("invalid");
  const parsed = new Map<string, XmlNode>();
  const budget: XmlBudget | undefined = aggregate
    ? { nodes: 0, text: 0 }
    : undefined;
  const read = (name: string): XmlNode => {
    const cached = parsed.get(name);
    if (cached) return cached;
    const data = parts.get(name);
    if (!data) throw new XlsxError("invalid");
    const node = parseXml(data, budget);
    parsed.set(name, node);
    return node;
  };
  const warnings = new Set<string>();
  const relations = (source: string): WorkbookRelation[] => {
    const slash = source.lastIndexOf("/"),
      path =
        (slash < 0 ? "" : source.slice(0, slash + 1)) +
        "_rels/" +
        source.slice(slash + 1) +
        ".rels";
    if (!parts.has(path)) return [];
    const root = read(path);
    requireRoot(root, "Relationships", PACKAGE_REL_NS);
    const ids = new Set<string>();
    return children(root, "Relationship").map((n) => {
      const id = attr(n, "Id"),
        type = attr(n, "Type"),
        raw = attr(n, "Target"),
        mode = attr(n, "TargetMode");
      if (
        !id ||
        !type ||
        raw === undefined ||
        ids.has(id) ||
        (mode !== undefined && mode !== "External" && mode !== "Internal")
      )
        throw new XlsxError("invalid");
      ids.add(id);
      const external = mode === "External";
      if (external) warnings.add("externalRelationships");
      return {
        id,
        type,
        target: external ? raw : resolveWorkbookPart(source, raw),
        external,
      };
    });
  };
  const single = (
    list: WorkbookRelation[],
    type: string,
    required = false,
  ): WorkbookRelation | undefined => {
    const matches = list.filter((r) => r.type === REL_NS + "/" + type);
    if (
      matches.length > 1 ||
      (required && !matches.length) ||
      matches.some((r) => r.external)
    )
      throw new XlsxError("invalid");
    return matches[0];
  };
  const document = single(relations(""), "officeDocument", true)!;
  const content = read("[Content_Types].xml");
  requireRoot(content, "Types", CONTENT_NS);
  const overrides = new Map<string, string>(),
    defaults = new Map<string, string>();
  for (const n of content.children) {
    if (n.uri !== CONTENT_NS || !["Override", "Default"].includes(n.name))
      throw new XlsxError("unsupported");
    const type = attr(n, "ContentType");
    if (!type || n.children.length || n.text.trim())
      throw new XlsxError("invalid");
    if (n.name === "Override") {
      const name = attr(n, "PartName");
      if (!name?.startsWith("/")) throw new XlsxError("invalid");
      const key = asciiLower(resolveWorkbookPart("", name));
      if (overrides.has(key)) throw new XlsxError("invalid");
      overrides.set(key, type);
    } else {
      const extension = attr(n, "Extension");
      if (!extension || /[.\\/%:#?\s\x00-\x1f\x7f]/.test(extension))
        throw new XlsxError("invalid");
      const key = asciiLower(extension);
      if (defaults.has(key)) throw new XlsxError("invalid");
      defaults.set(key, type);
    }
  }
  // OPC uses the exact part override first, then its extension default.
  // Neither lookup relaxes the supported non-macro workbook type below.
  const extension = document.target
    .split("/")
    .at(-1)!
    .split(".")
    .slice(1)
    .at(-1);
  if (
    (overrides.get(asciiLower(document.target)) ??
      defaults.get(asciiLower(extension ?? ""))) !==
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
  )
    throw new XlsxError("unsupported");
  const workbook = read(document.target);
  requireRoot(workbook, "workbook");
  const workbookRelations = relations(document.target),
    sheetNodes = child(workbook, "sheets");
  if (!sheetNodes) throw new XlsxError("invalid");
  const sheetIds = new Set<string>(),
    sheetNames = new Set<string>();
  const sheetParts = new Map<string, string>();
  const sheets = children(sheetNodes, "sheet").map((n) => {
    const id = attr(n, "id", REL_NS),
      name = xstring(attr(n, "name") ?? ""),
      state = attr(n, "state") ?? "visible";
    if (
      !id ||
      !name ||
      name.length > 128 ||
      sheetIds.has(id) ||
      sheetNames.has(name) ||
      !["visible", "hidden", "veryHidden"].includes(state)
    )
      throw new XlsxError("invalid");
    sheetIds.add(id);
    sheetNames.add(name);
    const relation = workbookRelations.find((r) => r.id === id);
    if (
      !relation ||
      relation.external ||
      relation.type !== REL_NS + "/worksheet" ||
      !parts.has(relation.target)
    )
      throw new XlsxError("unsupported");
    sheetParts.set(id, relation.target);
    return { id, name, state: state as "visible" | "hidden" | "veryHidden" };
  });
  if (!sheets.length || sheets.length > XLSX_LIMITS.sheets)
    throw new XlsxError("limit");
  const date1904 = boolean(
    child(workbook, "workbookPr") &&
      attr(child(workbook, "workbookPr")!, "date1904"),
  );
  const theme = single(workbookRelations, "theme"),
    themes = themeColors(theme ? read(theme.target) : undefined);
  const style = single(workbookRelations, "styles"),
    styleRoot = style ? read(style.target) : undefined,
    styles = parseStyles(styleRoot, themes, warnings);
  const shared = single(workbookRelations, "sharedStrings");
  const sharedRoot = shared ? read(shared.target) : undefined;
  let strings: SharedText[] = [];
  if (shared) {
    const root = sharedRoot!;
    requireRoot(root, "sst");
    const list = children(root, "si");
    if (list.length > XLSX_LIMITS.strings) throw new XlsxError("limit");
    strings = list.map((n) => richText(n, themes, warnings));
  }
  return {
    entries,
    read,
    relations,
    warnings,
    workbook,
    sheetParts,
    sheets,
    date1904,
    styles,
    styleRoot,
    sharedRoot,
    strings,
    themes,
  };
}
