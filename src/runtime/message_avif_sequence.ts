import {
  AvifContext,
  AvifCursor,
  type AvifBox,
  type AvifDimensions,
} from "./message_avif_reader";
import { rasterFrames, rasterRequire } from "./message_raster_reader";
import { avifItems } from "./message_avif_items";

export interface AvifTrack {
  id: number;
  size?: AvifDimensions;
  samples?: number;
  timedSamples?: number;
  fragments: number;
  display?: { width: number; height: number };
  handler?: string;
}

/** Counts container samples, not internal AV1 frames or playback duration. */
export function avifMovie(context: AvifContext, movie: AvifBox): AvifTrack[] {
  const tracks: AvifTrack[] = [];
  const ids = new Set<number>();
  for (const box of context.children(movie)) {
    if (box.kind !== "trak") continue;
    const track: AvifTrack = { id: 0, fragments: 0 };
    let unknownIdentity = false;
    const seen = new Set<string>();
    const walk = (parent: AvifBox): void => {
      for (const child of context.children(parent)) {
        if (["mdia", "minf", "stbl"].includes(child.kind)) {
          walk(child);
          continue;
        }
        if (child.kind === "meta") {
          avifItems(context, child);
          continue;
        }
        if (
          !["tkhd", "hdlr", "stsd", "stsz", "stz2", "stts"].includes(child.kind)
        )
          continue;
        rasterRequire(!seen.has(child.kind));
        seen.add(child.kind);
        const cursor = new AvifCursor(context, child);
        const full = cursor.full();
        if (child.kind === "tkhd") {
          if (full.version > 1) {
            context.uncovered = true;
            unknownIdentity = true;
            continue;
          }
          rasterRequire(child.end - child.data === (full.version ? 96 : 84));
          cursor.skip(full.version ? 16 : 8);
          track.id = cursor.uint(4);
          rasterRequire(track.id > 0);
          const width = Math.ceil(context.reader.u32be(child.end - 8) / 65_536);
          const height = Math.ceil(
            context.reader.u32be(child.end - 4) / 65_536,
          );
          // Bit 3 denotes an aspect ratio, not pixel dimensions. Unknown
          // flags retain compatibility without asserting a display size.
          if (full.flags & ~7) context.uncovered = true;
          else if (width && height) track.display = { width, height };
        } else if (child.kind === "hdlr") {
          if (full.version || full.flags) {
            context.uncovered = true;
            continue;
          }
          cursor.skip(4);
          rasterRequire(child.end - cursor.at >= 16);
          track.handler = context.text(cursor.at);
        } else if (child.kind === "stsd") {
          if (full.version > 1 || full.flags) {
            context.uncovered = true;
            continue;
          }
          const count = cursor.uint(4);
          context.record(count);
          let entries = 0;
          for (const entry of context.boxes(
            cursor.at,
            child.end,
            child.depth + 1,
          )) {
            entries++;
            if (entry.kind !== "av01") continue;
            rasterRequire(entry.end - entry.data >= 78);
            const size = context.dimensions(
              context.reader.u16be(entry.data + 24),
              context.reader.u16be(entry.data + 26),
            );
            if (
              !track.size ||
              size.width * size.height > track.size.width * track.size.height
            )
              track.size = size;
            // The payload and unknown configuration properties stay opaque.
            for (const property of context.children(entry, 78)) {
              if (property.kind === "ispe") {
                const field = new AvifCursor(context, property),
                  version = field.full();
                if (version.version || version.flags) context.uncovered = true;
                else {
                  const declared = context.dimensions(
                    field.uint(4),
                    field.uint(4),
                  );
                  field.done();
                  if (
                    declared.width * declared.height >
                    track.size.width * track.size.height
                  )
                    track.size = declared;
                }
              }
            }
          }
          rasterRequire(entries === count);
        } else if (child.kind === "stsz" || child.kind === "stz2") {
          rasterRequire(track.samples === undefined);
          if (full.version || full.flags) {
            context.uncovered = true;
            continue;
          }
          let stride = 0;
          if (child.kind === "stsz") stride = cursor.uint(4) ? 0 : 32;
          else {
            rasterRequire(cursor.uint(3) === 0);
            stride = cursor.uint(1);
            rasterRequire([4, 8, 16].includes(stride));
          }
          track.samples = cursor.uint(4);
          if (track.samples > 128 && track.size) rasterFrames(1, track.samples);
          if (stride) {
            context.record(track.samples);
            cursor.skip(Math.ceil((track.samples * stride) / 8));
          }
          cursor.done();
        } else {
          if (full.version || full.flags) {
            context.uncovered = true;
            continue;
          }
          const count = cursor.uint(4);
          context.record(count);
          let samples = 0;
          for (let index = 0; index < count; index++) {
            samples += cursor.uint(4);
            cursor.uint(4);
          }
          rasterRequire(Number.isSafeInteger(samples));
          track.timedSamples = samples;
          cursor.done();
        }
      }
    };
    walk(box);
    if (!track.id && unknownIdentity) track.id = -(tracks.length + 1);
    rasterRequire(track.id && !ids.has(track.id));
    ids.add(track.id);
    // AVIF §3 uses pict; older sequence writers also used vide. A known
    // picture handler establishes independent tkhd pixel/count declarations
    // even when an unknown stsd layout cannot supply an AV1 sample size.
    // Audio/other handlers do not turn their tkhd numbers into image budgets.
    if (
      track.display &&
      (track.size || ["pict", "vide"].includes(track.handler ?? ""))
    ) {
      const display = context.dimensions(
        track.display.width,
        track.display.height,
      );
      if (
        !track.size ||
        display.width * display.height > track.size.width * track.size.height
      )
        track.size = display;
    }
    tracks.push(track);
  }
  return tracks;
}

export function avifFragment(
  context: AvifContext,
  fragment: AvifBox,
  tracks: Map<number, AvifTrack>,
): void {
  for (const box of context.children(fragment)) {
    if (box.kind !== "traf") continue;
    let id = 0,
      count = 0;
    for (const child of context.children(box)) {
      if (!["tfhd", "trun"].includes(child.kind)) continue;
      const cursor = new AvifCursor(context, child),
        full = cursor.full();
      if (child.kind === "tfhd") {
        rasterRequire(!id);
        id = cursor.uint(4);
        if (full.version || full.flags & ~0x03003b) {
          context.uncovered = true;
          continue;
        }
        for (const [flag, bytes] of [
          [1, 8],
          [2, 4],
          [8, 4],
          [16, 4],
          [32, 4],
        ])
          if (full.flags & flag) cursor.skip(bytes);
        cursor.done();
      } else {
        if (full.version > 1 || full.flags & ~0xf05) {
          context.uncovered = true;
          continue;
        }
        const samples = cursor.uint(4);
        count += samples;
        if (full.flags & 1) cursor.skip(4);
        if (full.flags & 4) cursor.skip(4);
        let bytes = 0;
        for (const flag of [0x100, 0x200, 0x400, 0x800])
          if (full.flags & flag) bytes += 4;
        if (bytes) {
          context.record(samples);
          cursor.skip(samples * bytes);
        }
        cursor.done();
      }
    }
    const track = tracks.get(id);
    rasterRequire(track);
    track.fragments += count;
    rasterRequire(Number.isSafeInteger(track.fragments));
  }
}

export function avifTrackBudgets(
  context: AvifContext,
  tracks: Iterable<AvifTrack>,
): void {
  for (const track of tracks) {
    if (!track.size) continue; // Audio and other non-AV1 tracks are outside this image scope.
    const samples =
      Math.max(track.samples ?? 0, track.timedSamples ?? 0) + track.fragments;
    rasterFrames(track.size.width * track.size.height, samples);
    if (track.samples !== undefined && track.timedSamples !== undefined)
      rasterRequire(track.samples === track.timedSamples);
    if (!samples) context.uncovered = true;
    context.charge(track.size, samples);
  }
}
