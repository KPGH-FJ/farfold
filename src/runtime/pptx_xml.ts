import { SaxesParser } from "saxes";
import { PPTX_LIMITS, PptxError } from "./pptx_types";
import {
  extendXmlNamespaceScope,
  type XmlNamespaceScope,
} from "./xml_namespace_scope";

export const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
export const R =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const PR =
  "http://schemas.openxmlformats.org/package/2006/relationships";
export const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
export const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
export const WP =
  "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
export const PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture";
export interface PptxXml {
  name: string;
  uri: string;
  attrs: Record<string, string>;
  namespaces: XmlNamespaceScope;
  children: PptxXml[];
  text: string;
}
export interface XmlBudget {
  nodes: number;
  text: number;
}
export function attr(n: PptxXml, name: string, uri = ""): string | undefined {
  return n.attrs[uri ? `${uri}#${name}` : name];
}
export function children(n: PptxXml, name: string, uri = A): PptxXml[] {
  return n.children.filter((c) => c.name === name && c.uri === uri);
}
export function child(
  n: PptxXml | undefined,
  name: string,
  uri = A,
): PptxXml | undefined {
  if (!n) return;
  const matches = children(n, name, uri);
  if (matches.length > 1) throw new PptxError("invalid");
  return matches[0];
}
export function val(n: PptxXml | undefined): string | undefined {
  return n ? attr(n, "val") : undefined;
}
export function number(
  raw: string | undefined,
  min: number,
  max: number,
): number {
  if (raw === undefined || !/^[+-]?\d+(?:\.\d+)?$/.test(raw))
    throw new PptxError("invalid");
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max)
    throw new PptxError("limit");
  return value;
}
export function onOff(n: PptxXml): boolean {
  const raw = val(n);
  if (raw === undefined || ["1", "true", "on"].includes(raw)) return true;
  if (["0", "false", "off"].includes(raw)) return false;
  throw new PptxError("invalid");
}
export function root(n: PptxXml, name: string, uri = ""): void {
  if (n.name !== name || n.uri !== uri) throw new PptxError("unsupported");
}
export function parseXml(bytes: Uint8Array, budget: XmlBudget): PptxXml {
  if (bytes.length > PPTX_LIMITS.part) throw new PptxError("limit");
  const encoding =
    bytes[0] === 255 && bytes[1] === 254
      ? "utf-16le"
      : bytes[0] === 254 && bytes[1] === 255
        ? "utf-16be"
        : "utf-8";
  let source: string;
  try {
    source = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new PptxError("invalid");
  }
  const declared = source
    .match(/^\s*<\?xml[^?]*encoding\s*=\s*["']([^"']+)["']/i)?.[1]
    .toLowerCase();
  if (
    declared &&
    !(encoding === "utf-8" ? ["utf-8", "utf8"] : [encoding, "utf-16"]).includes(
      declared,
    )
  )
    throw new PptxError("unsupported");
  const stack: PptxXml[] = [];
  let result: PptxXml | undefined;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("doctype", () => {
    throw new PptxError("unsupported");
  });
  parser.on("opentag", (tag) => {
    if (
      ++budget.nodes > PPTX_LIMITS.nodes ||
      stack.length >= PPTX_LIMITS.depth ||
      Object.keys(tag.attributes).length > 64
    )
      throw new PptxError("limit");
    const attrs: Record<string, string> = Object.create(null);
    for (const a of Object.values(tag.attributes)) {
      if (a.value.length > 4096) throw new PptxError("limit");
      attrs[a.uri ? `${a.uri}#${a.local}` : a.local] = a.value;
    }
    const n: PptxXml = {
      name: tag.local,
      uri: tag.uri,
      attrs,
      namespaces: extendXmlNamespaceScope(stack.at(-1)?.namespaces, tag.ns),
      children: [],
      text: "",
    };
    if (stack.length) stack.at(-1)!.children.push(n);
    else {
      if (result) throw new PptxError("invalid");
      result = n;
    }
    stack.push(n);
  });
  const text = (value: string) => {
    budget.text += value.length;
    if (budget.text > PPTX_LIMITS.text) throw new PptxError("limit");
    if (stack.length) stack.at(-1)!.text += value;
  };
  parser.on("text", text);
  parser.on("cdata", text);
  parser.on("closetag", () => {
    stack.pop();
  });
  try {
    parser.write(source).close();
  } catch (e) {
    throw e instanceof PptxError ? e : new PptxError("invalid");
  }
  if (!result) throw new PptxError("invalid");
  return result;
}
