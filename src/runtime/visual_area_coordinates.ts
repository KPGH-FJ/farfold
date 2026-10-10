/** Fixed-point coordinates in the complete, display-oriented pixel rectangle. */
export const VISUAL_AREA_SCALE = 1_000_000;
export type VisualAreaRect = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
}>;
export type VisualAreaPoint = Readonly<{ x: number; y: number }>;
const keys = ["left", "top", "right", "bottom"] as const;

export function validVisualAreaRect(value: unknown): value is VisualAreaRect {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rect = value as VisualAreaRect;
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) =>
      keys.includes(key as (typeof keys)[number]),
    ) &&
    keys.every(
      (key) =>
        Number.isSafeInteger(rect[key]) &&
        rect[key] >= 0 &&
        rect[key] <= VISUAL_AREA_SCALE,
    ) &&
    rect.left < rect.right &&
    rect.top < rect.bottom
  );
}

/** User input is exact decimal percent, not an expression or rounded value. */
export function parseVisualAreaPercent(text: string): number | null {
  if (
    typeof text !== "string" ||
    !/^(?:0|[1-9]\d{0,2})(?:\.\d{1,4})?$/.test(text)
  )
    return null;
  const [whole, fraction = ""] = text.split(".");
  const unit = Number(whole) * 10_000 + Number(fraction.padEnd(4, "0"));
  return unit <= VISUAL_AREA_SCALE ? unit : null;
}

export function formatVisualAreaPercent(unit: number): string {
  if (!Number.isSafeInteger(unit) || unit < 0 || unit > VISUAL_AREA_SCALE)
    return "";
  const whole = Math.floor(unit / 10_000);
  const fraction = String(unit % 10_000)
    .padStart(4, "0")
    .replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Only pointer input may be reversed/clipped. Numeric rectangles stay strict. */
export function visualAreaRectFromPoints(
  a: VisualAreaPoint,
  b: VisualAreaPoint,
): VisualAreaRect | null {
  if (
    !a ||
    !b ||
    ![a.x, a.y, b.x, b.y].every(Number.isFinite) ||
    a.x === b.x ||
    a.y === b.y
  )
    return null;
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const left = clamp(Math.min(a.x, b.x)),
    right = clamp(Math.max(a.x, b.x));
  const top = clamp(Math.min(a.y, b.y)),
    bottom = clamp(Math.max(a.y, b.y));
  if (left >= right || top >= bottom) return null;
  const rect = {
    left: Math.floor(left * VISUAL_AREA_SCALE),
    top: Math.floor(top * VISUAL_AREA_SCALE),
    right: Math.ceil(right * VISUAL_AREA_SCALE),
    bottom: Math.ceil(bottom * VISUAL_AREA_SCALE),
  };
  return validVisualAreaRect(rect) ? Object.freeze(rect) : null;
}
