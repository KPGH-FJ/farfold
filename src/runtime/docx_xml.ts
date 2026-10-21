import { SaxesParser } from "saxes";
import { DOCX_LIMITS, DocxError } from "./docx_types";
import {
  extendXmlNamespaceScope,
  type XmlNamespaceScope,
} from "./xml_namespace_scope";

export const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const R =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const PR =
  "http://schemas.openxmlformats.org/package/2006/relationships";
export const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
export const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
export const WP =
  "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
export const PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture";
export interface DocxXml {
  name: string;
  uri: string;
  attrs: Record<string, string>;
  namespaces: XmlNamespaceScope;
  children: DocxXml[];
  text: string;
}
export interface XmlBudget {
  nodes: number;
  text: number;
}
export function attr(n: DocxXml, name: string, uri = W): string | undefined {
  return n.attrs[uri ? `${uri}#${name}` : name];
}
export function children(n: DocxXml, name: string, uri = W): DocxXml[] {
  return n.children.filter((c) => c.name === name && c.uri === uri);
}
export function child(
  n: DocxXml | undefined,
  name: string,
  uri = W,
): DocxXml | undefined {
  if (!n) return;
  const matches = children(n, name, uri);
  if (matches.length > 1) throw new DocxError("invalid");
  return matches[0];
}
export function val(n: DocxXml | undefined): string | undefined {
  return n ? attr(n, "val") : undefined;
}
export function number(
  raw: string | undefined,
  min: number,
  max: number,
): number {
  if (raw === undefined || !/^[+-]?\d+(?:\.\d+)?$/.test(raw))
    throw new DocxError("invalid");
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max)
    throw new DocxError("limit");
  return value;
}
export function onOff(n: DocxXml): boolean {
  const raw = val(n);
  if (raw === undefined || ["1", "true", "on"].includes(raw)) return true;
  if (["0", "false", "off"].includes(raw)) return false;
  throw new DocxError("invalid");
}
export function root(n: DocxXml, name: string, uri = W): void {
  if (n.name !== name || n.uri !== uri) throw new DocxError("unsupported");
}
export function parseXml(bytes: Uint8Array, budget: XmlBudget): DocxXml {
  if (bytes.length > DOCX_LIMITS.part) throw new DocxError("limit");
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
    throw new DocxError("invalid");
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
    throw new DocxError("unsupported");
  const stack: DocxXml[] = [];
  let result: DocxXml | undefined;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("doctype", () => {
    throw new DocxError("unsupported");
  });
  parser.on("opentag", (tag) => {
    if (
      ++budget.nodes > DOCX_LIMITS.nodes ||
      stack.length >= DOCX_LIMITS.depth ||
      Object.keys(tag.attributes).length > 64
    )
      throw new DocxError("limit");
    const attrs: Record<string, string> = Object.create(null);
    for (const a of Object.values(tag.attributes)) {
      if (a.value.length > 4096) throw new DocxError("limit");
      attrs[a.uri ? `${a.uri}#${a.local}` : a.local] = a.value;
    }
    const n: DocxXml = {
      name: tag.local,
      uri: tag.uri,
      attrs,
      namespaces: extendXmlNamespaceScope(stack.at(-1)?.namespaces, tag.ns),
      children: [],
      text: "",
    };
    if (stack.length) stack.at(-1)!.children.push(n);
    else {
      if (result) throw new DocxError("invalid");
      result = n;
    }
    stack.push(n);
  });
  const text = (value: string) => {
    budget.text += value.length;
    if (budget.text > DOCX_LIMITS.text) throw new DocxError("limit");
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
    throw e instanceof DocxError ? e : new DocxError("invalid");
  }
  if (!result) throw new DocxError("invalid");
  return result;
}
/** Choose once; never collect the text of both compatibility branches. */
export function compatible(n: DocxXml): DocxXml[] {
  if (n.uri !== MC || n.name !== "AlternateContent") return [n];
  const known = new Set([W, R, A, WP, PIC]);
  let chosen: DocxXml | undefined;
  let fallback: DocxXml | undefined;
  for (const c of n.children) {
    if (c.uri !== MC) throw new DocxError("unsupported");
    if (c.name === "Choice" && !fallback) {
      const requires = attr(c, "Requires", "")?.trim().split(/\s+/);
      if (!requires?.length || !requires[0]) throw new DocxError("invalid");
      if (!chosen && requires.every((p) => known.has(c.namespaces[p])))
        chosen = c;
    } else if (c.name === "Fallback" && !fallback) fallback = c;
    else throw new DocxError("invalid");
  }
  const selected = chosen ?? fallback;
  if (!selected) throw new DocxError("unsupported");
  return selected.children;
}
