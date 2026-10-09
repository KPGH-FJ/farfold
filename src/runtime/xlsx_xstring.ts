/** OOXML ST_Xstring: one pass over each original field/run. Replacements must
 * not be scanned again, and adjacent rich text runs cannot create an escape. */
export function xstring(value: string): string {
  return value.replace(/_x([0-9a-fA-F]{4})_/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}
