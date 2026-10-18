import type { MessageRasterReader } from "./message_raster_reader";

interface FragmentBox {
  kind: string;
  data: number;
  end: number;
}
interface FragmentClock {
  scale: number;
  ticks: bigint | null;
}

/** Shares the caller's reader, work budget and error boundary. No media bytes
 * are copied or decoded; this module only visits known fragment declarations. */
export interface Mp4FragmentContext {
  readonly reader: MessageRasterReader;
  uncovered: boolean;
  record(count?: number): void;
  text(at: number): string;
  boxes(start: number, end: number, top?: boolean): Iterable<FragmentBox>;
  children(box: FragmentBox): Iterable<FragmentBox>;
  version(
    box: FragmentBox,
    supported: readonly number[],
    allowedFlags?: number,
  ): number | null;
  clock(box: FragmentBox): FragmentClock | null;
  overBudget(ticks: bigint | null, scale: number): boolean;
  reject(reason: "invalid" | "audioTooLong" | "audioTooComplex"): never;
}

interface Track {
  audio: boolean;
  scale: number;
  ticks: bigint;
}
interface Header {
  id: number;
  duration?: number;
  empty: boolean;
}
interface Run {
  samples: number;
  ticks: bigint;
  partial: boolean;
}

function requireFragment(
  context: Mp4FragmentContext,
  value: unknown,
): asserts value {
  if (!value) context.reject("invalid");
}

/** A field cursor bounds optional headers against their own box, even when a
 * following sibling would otherwise make the underlying source read succeed. */
class Fields {
  at: number;
  constructor(
    readonly context: Mp4FragmentContext,
    readonly box: FragmentBox,
  ) {
    this.at = box.data + 4;
  }
  uint(): number {
    requireFragment(this.context, this.at + 4 <= this.box.end);
    const value = this.context.reader.u32be(this.at);
    this.at += 4;
    return value;
  }
  skip(bytes: number): void {
    requireFragment(this.context, this.at + bytes <= this.box.end);
    this.at += bytes;
  }
  done(): void {
    requireFragment(this.context, this.at === this.box.end);
  }
}

function unique(
  context: Mp4FragmentContext,
  previous: FragmentBox | undefined,
  next: FragmentBox,
): FragmentBox {
  requireFragment(context, previous === undefined);
  return next;
}

function flags(context: Mp4FragmentContext, box: FragmentBox): number {
  return (
    context.reader.u8(box.data + 1) * 65_536 +
    context.reader.u16be(box.data + 2)
  );
}

function trackIdentity(
  context: Mp4FragmentContext,
  header: FragmentBox,
): number | null {
  // Enabled/in-movie/in-preview/aspect-ratio flags do not alter these offsets.
  const version = context.version(header, [0, 1], 0x0f);
  if (version === null) return null;
  const bytes = version === 0 ? 84 : 96;
  requireFragment(context, header.data + bytes <= header.end);
  if (header.data + bytes !== header.end) context.uncovered = true;
  const id = context.reader.u32be(header.data + (version === 0 ? 12 : 20));
  requireFragment(context, id > 0);
  return id;
}

function trackClock(context: Mp4FragmentContext, media?: FragmentBox): Track {
  let header: FragmentBox | undefined;
  let handler: FragmentBox | undefined;
  if (media)
    for (const box of context.children(media)) {
      if (box.kind === "mdhd") header = unique(context, header, box);
      else if (box.kind === "hdlr") handler = unique(context, handler, box);
    }
  let audio = false;
  if (handler && context.version(handler, [0]) !== null) {
    requireFragment(context, handler.data + 24 <= handler.end);
    audio = context.text(handler.data + 8) === "soun";
  } else context.uncovered = true;
  const clock = header ? context.clock(header) : null;
  if (!clock || clock.scale === 0) context.uncovered = true;
  // A zero/unknown mdhd duration does not erase a separately known time scale.
  return { audio, scale: clock?.scale ?? 0, ticks: 0n };
}

function movieTracks(
  context: Mp4FragmentContext,
  movie: FragmentBox,
): {
  tracks: Map<number, Track>;
  defaults: Map<number, number>;
} {
  const tracks = new Map<number, Track>();
  const defaults = new Map<number, number>();
  let extensions: FragmentBox | undefined;
  for (const box of context.children(movie)) {
    if (box.kind === "mvex") {
      extensions = unique(context, extensions, box);
      continue;
    }
    if (box.kind !== "trak") continue;
    let header: FragmentBox | undefined;
    let media: FragmentBox | undefined;
    for (const child of context.children(box)) {
      if (child.kind === "tkhd") header = unique(context, header, child);
      else if (child.kind === "mdia") media = unique(context, media, child);
    }
    const id = header ? trackIdentity(context, header) : null;
    if (id === null) {
      context.uncovered = true;
      continue;
    }
    // The index includes video/other tracks, so no first/last-wins clock alias.
    requireFragment(context, !tracks.has(id));
    tracks.set(id, trackClock(context, media));
  }
  if (extensions)
    for (const box of context.children(extensions)) {
      if (box.kind !== "trex" || context.version(box, [0]) === null) continue;
      const fields = new Fields(context, box);
      const id = fields.uint();
      requireFragment(context, id > 0 && !defaults.has(id));
      fields.skip(4); // default sample description index
      const duration = fields.uint();
      fields.skip(8); // default sample size and flags do not add elapsed time
      fields.done();
      defaults.set(id, duration);
      if (!tracks.has(id)) context.uncovered = true;
    }
  return { tracks, defaults };
}

function fragmentHeader(
  context: Mp4FragmentContext,
  box: FragmentBox,
): Header | null {
  if (context.version(box, [0], 0x03003b) === null) return null;
  const present = flags(context, box);
  const fields = new Fields(context, box);
  const id = fields.uint();
  requireFragment(context, id > 0);
  if (present & 1) fields.skip(8); // base data offset
  if (present & 2) fields.skip(4); // sample description index
  const duration = present & 8 ? fields.uint() : undefined;
  if (present & 0x10) fields.skip(4); // default sample size
  if (present & 0x20) fields.skip(4); // default sample flags
  fields.done();
  return { id, duration, empty: !!(present & 0x010000) };
}

function fragmentRun(
  context: Mp4FragmentContext,
  box: FragmentBox,
  defaultDuration: number | undefined,
): Run | null {
  if (context.version(box, [0, 1], 0x0f05) === null) return null;
  const present = flags(context, box);
  const fields = new Fields(context, box);
  const samples = fields.uint();
  if (present & 1) fields.skip(4); // data offset, unrelated to duration
  if (present & 4) fields.skip(4); // first sample flags
  let stride = 0;
  for (const flag of [0x100, 0x200, 0x400, 0x800])
    if (present & flag) stride += 4;
  requireFragment(context, fields.at + samples * stride === box.end);
  if (stride) context.record(samples);
  if (!(present & 0x100)) {
    // Presence is significant. An explicit zero is not a license to borrow a
    // different positive default: decoder behavior differs for that case.
    const known = defaultDuration !== undefined && defaultDuration > 0;
    return {
      samples,
      ticks: known ? BigInt(samples) * BigInt(defaultDuration) : 0n,
      partial: samples > 0 && !known,
    };
  }
  let ticks = 0n;
  let partial = false;
  // A positive stride was checked and charged before this actual entry walk.
  for (let at = fields.at; at < box.end; at += stride) {
    const duration = context.reader.u32be(at);
    if (duration === 0) partial = true;
    else ticks += BigInt(duration);
  }
  return { samples, ticks, partial };
}

/** Selected stored-sample declarations only. tfdt gaps, edits, composition
 * offsets, parallel tracks and the classic timeline are not added to this sum.
 * Missing playback/addressing details keep the caller's fragment result partial;
 * they cannot hide a separately known positive same-track total above policy.
 */
export function mp4FragmentBudgets(
  context: Mp4FragmentContext,
  movie: FragmentBox,
  fragments: readonly FragmentBox[],
): void {
  const { tracks, defaults } = movieTracks(context, movie);
  for (const fragment of fragments)
    for (const box of context.children(fragment)) {
      if (box.kind !== "traf") continue;
      let header: FragmentBox | undefined;
      const runs: FragmentBox[] = [];
      for (const child of context.children(box)) {
        if (child.kind === "tfhd") header = unique(context, header, child);
        else if (child.kind === "trun") runs.push(child);
      }
      const timing = header ? fragmentHeader(context, header) : null;
      const track = timing ? tracks.get(timing.id) : undefined;
      if (!timing || !track) context.uncovered = true;
      const duration =
        timing?.duration !== undefined
          ? timing.duration
          : timing
            ? defaults.get(timing.id)
            : undefined;
      for (const box of runs) {
        const run = fragmentRun(context, box, duration);
        if (!run) continue;
        if (timing?.empty) requireFragment(context, run.samples === 0);
        if (run.partial) context.uncovered = true;
        if (!track) continue;
        track.ticks += run.ticks;
        if (track.audio && context.overBudget(track.ticks, track.scale))
          context.reject("audioTooLong");
      }
    }
}
