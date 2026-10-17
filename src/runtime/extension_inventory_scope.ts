const EMPTY_ROOTS: readonly string[] = Object.freeze([]);
const MAX_ROOTS = 4;
const MAX_ROOT_BYTES = 4096;
const MAX_TOTAL_ROOT_BYTES = 16 * 1024;

export function validInventoryDirectory(value: string): boolean {
  return (
    /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(value) &&
    new TextEncoder().encode(value).length <= MAX_ROOT_BYTES &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  );
}

/** Preserve requested spelling and order. Actual directory identity and alias
 * duplication are checked by the backend, never inferred from UI strings. */
export function freezeInventoryExtraRoots(
  value: unknown,
): readonly string[] | null {
  if (value === undefined) return EMPTY_ROOTS;
  if (!Array.isArray(value) || value.length > MAX_ROOTS) return null;
  let bytes = 0;
  const unique = new Set<string>();
  for (const root of value) {
    if (
      typeof root !== "string" ||
      !validInventoryDirectory(root) ||
      unique.has(root)
    )
      return null;
    bytes += new TextEncoder().encode(root).length;
    if (bytes > MAX_TOTAL_ROOT_BYTES) return null;
    unique.add(root);
  }
  return value.length ? Object.freeze([...value]) : EMPTY_ROOTS;
}

export function sameInventoryExtraRoots(a: unknown, b: unknown): boolean {
  const left = freezeInventoryExtraRoots(a),
    right = freezeInventoryExtraRoots(b);
  return (
    left !== null &&
    right !== null &&
    left.length === right.length &&
    left.every((root, index) => root === right[index])
  );
}
