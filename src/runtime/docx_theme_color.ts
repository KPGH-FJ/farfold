/** WordprocessingML themeTint/themeShade alter HSL luminance. Tint is a
 * modulation factor (99 = 60% original luminance + 40% white), unlike the
 * percentage-of-white convention used by some other Office color formats.
 * MS-OI29500 2.1.72, color: https://learn.microsoft.com/en-us/openspecs/
 * office_standards/ms-oi29500/8229a077-7fc8-4fba-96cc-c77b6a4fc768
 * The caller supplies a checked #RRGGBB and a checked two-digit hex modifier. */
export function wordThemeColor(
  color: string,
  modifier: string,
  tint: boolean,
): string {
  const amount = parseInt(modifier, 16) / 255;
  if (amount === 1) return color;
  if (amount === 0) return tint ? "#FFFFFF" : "#000000";
  const [r, g, b] = [1, 3, 5].map(
    (at) => parseInt(color.slice(at, at + 2), 16) / 255,
  );
  const hi = Math.max(r, g, b),
    lo = Math.min(r, g, b),
    delta = hi - lo;
  const light = (hi + lo) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * light - 1));
  let hue =
    delta === 0
      ? 0
      : hi === r
        ? ((g - b) / delta) % 6
        : hi === g
          ? (b - r) / delta + 2
          : (r - g) / delta + 4;
  if (hue < 0) hue += 6;
  const next = light * amount + (tint ? 1 - amount : 0);
  const chroma = (1 - Math.abs(2 * next - 1)) * saturation,
    x = chroma * (1 - Math.abs((hue % 2) - 1)),
    m = next - chroma / 2;
  const channels =
    hue < 1
      ? [chroma, x, 0]
      : hue < 2
        ? [x, chroma, 0]
        : hue < 3
          ? [0, chroma, x]
          : hue < 4
            ? [0, x, chroma]
            : hue < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  return (
    "#" +
    channels
      .map((v) =>
        Math.max(0, Math.min(255, Math.round((v + m) * 255)))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
      .toUpperCase()
  );
}
