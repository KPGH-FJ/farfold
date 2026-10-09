export type PromptTemplate = { id: string; label: string; text: string };
export type TemplateEditDraft = PromptTemplate & { original?: PromptTemplate };
export type PromptTemplateDocument = { version: 1; items: PromptTemplate[] };

export const TEMPLATE_LIMITS = {
  count: 100,
  label: 80,
  text: 32000,
  bytes: 1024 * 1024,
} as const;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid template");
  return value as Record<string, unknown>;
}
function keys(raw: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(raw).some((key) => !allowed.includes(key)))
    throw new Error("unsupported template format");
}
function template(value: unknown, unfinished = false): PromptTemplate {
  const raw = record(value);
  keys(raw, ["id", "label", "text"]);
  if (
    typeof raw.id !== "string" ||
    !raw.id.trim() ||
    raw.id.length > 128 ||
    /[\u0000-\u001f]/.test(raw.id) ||
    typeof raw.label !== "string" ||
    raw.label.length > TEMPLATE_LIMITS.label ||
    typeof raw.text !== "string" ||
    raw.text.length > TEMPLATE_LIMITS.text ||
    (!unfinished && (!raw.label.trim() || !raw.text.trim()))
  )
    throw new Error("invalid template");
  return Object.freeze({ id: raw.id, label: raw.label, text: raw.text });
}
export function parsePromptTemplates(value: unknown): PromptTemplateDocument {
  if (value === null) return { version: 1, items: [] };
  const raw = record(value);
  keys(raw, ["version", "items"]);
  if (
    raw.version !== 1 ||
    !Array.isArray(raw.items) ||
    raw.items.length > TEMPLATE_LIMITS.count
  )
    throw new Error("invalid template document");
  const items = raw.items.map((item) => template(item));
  if (
    new Set(items.map((item) => item.id)).size !== items.length ||
    new TextEncoder().encode(JSON.stringify(raw)).byteLength >
      TEMPLATE_LIMITS.bytes
  )
    throw new Error("invalid template document");
  return { version: 1, items };
}
export function parseTemplateEdit(value: unknown): TemplateEditDraft | null {
  if (value === null || value === undefined) return null;
  const raw = record(value);
  keys(raw, ["id", "label", "text", "original"]);
  const current = template(
    { id: raw.id, label: raw.label, text: raw.text },
    true,
  );
  if (Object.hasOwn(raw, "original")) {
    const original = template(raw.original);
    if (original.id !== current.id)
      throw new Error("invalid template original");
    return Object.freeze({ ...current, original });
  }
  return Object.freeze(current);
}
