import { AvifContext, AvifCursor, type AvifBox } from "./message_avif_reader";
import { rasterRequire } from "./message_raster_reader";

export interface AvifLayers {
  count: number;
  precedingBytes: number;
}

/** AVIF 1.2 §2.3.2.3: a1lx describes up to four spatial layers, not animation
 * samples. Count their selected-ispe canvases conservatively under the existing
 * declared-pixel-work policy. This is neither an AV1 frame-size/decoder-work
 * measurement nor a guarantee about intermediate images or actual allocation.
 *
 * a1op/lsel cannot safely reduce this count without AV1 dependency/layer IDs:
 * a1lx array positions need not equal spatial_id, and a selected layer may
 * depend on other layers. Unknown future reserved bits preserve compatibility.
 * https://aomediacodec.github.io/av1-avif/v1.2.0.html#layered-image-indexing-property
 */
export function avifLayers(
  context: AvifContext,
  box: AvifBox,
): AvifLayers | null {
  const cursor = new AvifCursor(context, box);
  const flags = cursor.uint(1);
  if (flags & 0xfe) {
    context.uncovered = true;
    return null;
  }
  const bytes = flags & 1 ? 4 : 2;
  let count = 1,
    precedingBytes = 0,
    ended = false;
  context.record(3);
  for (let index = 0; index < 3; index++) {
    const length = cursor.uint(bytes);
    if (!length) ended = true;
    else {
      // Zero terminates the documented leading layers; later slots stay zero.
      rasterRequire(!ended);
      count++;
      precedingBytes += length;
    }
  }
  cursor.done();
  return { count, precedingBytes };
}
