import { xstring } from "./xlsx_xstring";
import { parseSheet, richText, type SharedText } from "./xlsx_sheet";
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
} from "./xlsx_xml";
import {
  XLSX_LIMITS,
  XlsxError,
  type WorkbookPreview,
  type XlsxWorkerInput,
} from "./xlsx_types";

const CONTENT_NS =
  "http://schemas.openxmlformats.org/package/2006/content-types";
interface Relation {
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
      .some((p) => !p || p === "." || p === "..")
  )
    throw new XlsxError("invalid");
}
function resolvePart(from: string, target: string): string {
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
export function parseWorkbook(input: XlsxWorkerInput): WorkbookPreview {
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
  const read = (name: string): XmlNode => {
    const data = parts.get(name);
    if (!data) throw new XlsxError("invalid");
    return parseXml(data);
  };
  const warnings = new Set<string>();
  const relations = (source: string): Relation[] => {
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
        target: external ? raw : resolvePart(source, raw),
        external,
      };
    });
  };
  const single = (
    list: Relation[],
    type: string,
    required = false,
  ): Relation | undefined => {
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
  const overrides = new Map<string, string>();
  for (const n of children(content, "Override")) {
    const name = attr(n, "PartName"),
      type = attr(n, "ContentType");
    if (!name?.startsWith("/") || !type) throw new XlsxError("invalid");
    const key = resolvePart("", name);
    if (overrides.has(key)) throw new XlsxError("invalid");
    overrides.set(key, type);
  }
  if (
    overrides.get(document.target) !==
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
    styles = parseStyles(
      style ? read(style.target) : undefined,
      themes,
      warnings,
    );
  const shared = single(workbookRelations, "sharedStrings");
  let strings: SharedText[] = [];
  if (shared) {
    const root = read(shared.target);
    requireRoot(root, "sst");
    const list = children(root, "si");
    if (list.length > XLSX_LIMITS.strings) throw new XlsxError("limit");
    strings = list.map((n) => richText(n, themes, warnings));
  }
  const selected =
    input.sheetId ??
    sheets.find((s) => s.state === "visible")?.id ??
    sheets[0].id;
  const sheetPart = sheetParts.get(selected);
  if (!sheetPart) throw new XlsxError("invalid");
  // Relationships are checked even though no links or embedded assets are opened.
  relations(sheetPart);
  const sheet = parseSheet(
    read(sheetPart),
    selected,
    styles,
    strings,
    themes,
    date1904,
    warnings,
  );
  for (const name of entries) {
    const feature = name
      .split("/")
      .find((p) =>
        [
          "media",
          "charts",
          "pivotTables",
          "pivotCache",
          "externalLinks",
          "embeddings",
          "activeX",
        ].includes(p),
      );
    if (feature)
      warnings.add(
        (
          {
            media: "images",
            charts: "charts",
            pivotTables: "pivotTables",
            pivotCache: "pivotTables",
            externalLinks: "externalLinks",
            embeddings: "embeddedObjects",
            activeX: "embeddedObjects",
          } as Record<string, string>
        )[feature],
      );
    if (/vbaProject|macrosheets/i.test(name)) warnings.add("macrosNotExecuted");
  }
  const calc = child(workbook, "calcPr");
  if (
    calc &&
    (boolean(attr(calc, "fullCalcOnLoad")) ||
      boolean(attr(calc, "forceFullCalc")) ||
      attr(calc, "calcMode") === "manual")
  )
    warnings.add("recalculationRequested");
  return { date1904, sheets, styles, sheet, warnings: [...warnings] };
}
