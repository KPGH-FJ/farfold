import {
  MessageRasterError,
  MessageRasterReader,
  type MessageRasterRejection,
  rasterRequire,
} from "./message_raster_reader";
import { AvifContext, type AvifBox } from "./message_avif_reader";
import { avifItems } from "./message_avif_items";
import {
  avifMovie,
  avifFragment,
  avifTrackBudgets,
  type AvifTrack,
} from "./message_avif_sequence";

export type MessageAvifAdmission =
  "notAvif" | "withinBudget" | "notCovered" | MessageRasterRejection;

/** After canonical Base64 and the common byte gate. AVIF/HEIF container
 * declarations only: ispe/sample sizes do not bound AV1 maximum/intermediate
 * frames, codec allocation, duration, looping, transport or actual decoding.
 * https://aomediacodec.github.io/av1-avif/v1.2.0.html
 */
export function messageAvifAdmission(
  data: string,
  declaredAvif: boolean,
): MessageAvifAdmission {
  const reader = new MessageRasterReader(data);
  if (!reader.matches(4, "ftyp")) return declaredAvif ? "invalid" : "notAvif";
  try {
    const context = new AvifContext(reader);
    const boxes = context.boxes(0, reader.length);
    const first = boxes.next().value as AvifBox | undefined;
    rasterRequire(
      first?.kind === "ftyp" &&
        first.end - first.data >= 8 &&
        (first.end - first.data) % 4 === 0,
    );
    let identified = ["avif", "avis"].includes(context.text(first.data));
    for (let at = first.data + 8; at < first.end; at += 4) {
      context.record();
      if (["avif", "avis"].includes(context.text(at))) identified = true;
    }
    if (!identified) return declaredAvif ? "invalid" : "notAvif";
    const tracks = new Map<number, AvifTrack>();
    const fragments: AvifBox[] = [];
    let metadata = false,
      movie = false;
    for (const box of boxes) {
      rasterRequire(box.kind !== "ftyp");
      if (box.kind === "meta") {
        rasterRequire(!metadata);
        metadata = true;
        avifItems(context, box);
      } else if (box.kind === "moov") {
        rasterRequire(!movie);
        movie = true;
        for (const track of avifMovie(context, box))
          tracks.set(track.id, track);
      } else if (box.kind === "moof") fragments.push(box);
    }
    for (const fragment of fragments) avifFragment(context, fragment, tracks);
    avifTrackBudgets(context, tracks.values());
    rasterRequire(metadata || movie);
    if (!context.declarations && !context.uncovered) rasterRequire(false);
    return context.uncovered ? "notCovered" : "withinBudget";
  } catch (error) {
    if (error instanceof MessageRasterError) return error.reason;
    throw error;
  }
}
