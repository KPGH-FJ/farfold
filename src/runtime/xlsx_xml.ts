import { SaxesParser } from "saxes";
import { XLSX_LIMITS, XlsxError } from "./xlsx_types";

export const SHEET_NS =
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
export const REL_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const PACKAGE_REL_NS =
  "http://schemas.openxmlformats.org/package/2006/relationships";
export interface XmlNode {
  name: string;
  uri: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}
export function attr(
  node: XmlNode,
  name: string,
  uri = "",
): string | undefined {
  return node.attrs[uri ? `${uri}#${name}` : name];
}
export function children(
  node: XmlNode,
  name: string,
  uri = node.uri,
): XmlNode[] {
  return node.children.filter((n) => n.name === name && n.uri === uri);
}
export function child(
  node: XmlNode,
  name: string,
  uri = node.uri,
): XmlNode | undefined {
  const result = children(node, name, uri);
  if (result.length > 1) throw new XlsxError("invalid");
  return result[0];
}
export function integer(
  raw: string | undefined,
  min: number,
  max: number,
  fallback?: number,
): number {
  if (raw === undefined && fallback !== undefined) return fallback;
  if (raw === undefined || !/^\d+$/.test(raw)) throw new XlsxError("invalid");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new XlsxError("invalid");
  return value;
}
export function decimal(
  raw: string | undefined,
  min = -Number.MAX_VALUE,
  max = Number.MAX_VALUE,
): number {
  if (
    raw === undefined ||
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(raw)
  )
    throw new XlsxError("invalid");
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max)
    throw new XlsxError("invalid");
  return value;
}
export function boolean(raw: string | undefined, fallback = false): boolean {
  if (raw === undefined) return fallback;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new XlsxError("invalid");
}
export function parseXml(bytes: Uint8Array): XmlNode {
  if (bytes.length > XLSX_LIMITS.partBytes) throw new XlsxError("limit");
  let source: string;
  try {
    const encoding =
      bytes[0] === 255 && bytes[1] === 254
        ? "utf-16le"
        : bytes[0] === 254 && bytes[1] === 255
          ? "utf-16be"
          : "utf-8";
    source = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    const declared = source
      .match(/^\s*<\?xml[^?]*encoding\s*=\s*["']([^"']+)["']/i)?.[1]
      .toLowerCase();
    if (
      declared &&
      !(
        encoding === "utf-8" ? ["utf-8", "utf8"] : [encoding, "utf-16"]
      ).includes(declared)
    )
      throw new XlsxError("unsupported");
  } catch (error) {
    if (error instanceof XlsxError) throw error;
    throw new XlsxError("invalid");
  }
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined,
    count = 0,
    text = 0;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("doctype", () => {
    throw new XlsxError("unsupported");
  });
  parser.on("opentag", (node) => {
    if (
      ++count > XLSX_LIMITS.xmlNodes ||
      stack.length >= XLSX_LIMITS.xmlDepth ||
      Object.keys(node.attributes).length > XLSX_LIMITS.attributes
    )
      throw new XlsxError("limit");
    const attrs: Record<string, string> = Object.create(null);
    for (const a of Object.values(node.attributes)) {
      if (a.value.length > 4096) throw new XlsxError("limit");
      attrs[a.uri ? `${a.uri}#${a.local}` : a.local] = a.value;
    }
    const next: XmlNode = {
      name: node.local,
      uri: node.uri,
      attrs,
      children: [],
      text: "",
    };
    if (stack.length) stack[stack.length - 1].children.push(next);
    else {
      if (root) throw new XlsxError("invalid");
      root = next;
    }
    stack.push(next);
  });
  const addText = (value: string) => {
    text += value.length;
    if (text > XLSX_LIMITS.text) throw new XlsxError("limit");
    if (stack.length) stack[stack.length - 1].text += value;
  };
  parser.on("text", addText);
  parser.on("cdata", addText);
  parser.on("closetag", () => {
    stack.pop();
  });
  try {
    parser.write(source).close();
  } catch (error) {
    if (error instanceof XlsxError) throw error;
    throw new XlsxError("invalid");
  }
  if (!root) throw new XlsxError("invalid");
  return root;
}
export function requireRoot(node: XmlNode, name: string, uri = SHEET_NS): void {
  if (node.name !== name || node.uri !== uri)
    throw new XlsxError("unsupported");
}
