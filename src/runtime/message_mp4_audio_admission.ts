import {
  MAX_MESSAGE_AUDIO_RECORDS,
  MAX_MESSAGE_AUDIO_SECONDS,
} from "./message_audio_admission";
import {
  MessageRasterError,
  MessageRasterReader,
} from "./message_raster_reader";
import { mp4FragmentBudgets } from "./message_mp4_fragments";

export type MessageMp4AudioAdmission =
  | "notMp4Audio"
  | "withinBudget"
  | "notCovered"
  | "invalid"
  | "audioTooLong"
  | "audioTooComplex";

interface Box {
  kind: string;
  data: number;
  end: number;
}
interface Clock {
  scale: number;
  ticks: bigint | null;
}
interface Timeline {
  ticks: bigint;
  partial: boolean;
}

class Mp4AudioError extends Error {
  constructor(readonly reason: "invalid" | "audioTooLong" | "audioTooComplex") {
    super(reason);
  }
}

function requireMp4(value: unknown): asserts value {
  if (!value) throw new Mp4AudioError("invalid");
}

/** This fixed hierarchy only visits container headers and timing entries, not
 * mdat/sample payloads or unknown leaf contents. No AVIF semantics are reused. */
class Mp4AudioContext {
  records = 0;
  uncovered = false;
  audioTracks = 0;
  constructor(readonly reader: MessageRasterReader) {}
  reject(reason: "invalid" | "audioTooLong" | "audioTooComplex"): never {
    throw new Mp4AudioError(reason);
  }
  record(count = 1): void {
    this.records += count;
    if (this.records > MAX_MESSAGE_AUDIO_RECORDS)
      throw new Mp4AudioError("audioTooComplex");
  }
  text(at: number): string {
    const value = this.reader.u32be(at);
    return String.fromCharCode(
      value >>> 24,
      (value >>> 16) & 255,
      (value >>> 8) & 255,
      value & 255,
    );
  }
  u64(at: number): bigint {
    return (
      (BigInt(this.reader.u32be(at)) << 32n) | BigInt(this.reader.u32be(at + 4))
    );
  }
  *boxes(start: number, end: number, top = false): Generator<Box> {
    this.reader.require(start, end - start);
    let at = start;
    while (at < end) {
      this.record();
      requireMp4(at + 8 <= end);
      let size = this.reader.u32be(at);
      const kind = this.text(at + 4);
      let header = 8;
      if (size === 1) {
        requireMp4(at + 16 <= end);
        const extended = this.u64(at + 8);
        requireMp4(extended <= BigInt(end - at));
        size = Number(extended);
        header = 16;
      } else if (size === 0) {
        // QTFF/ISO atom-size zero denotes the final top-level box to EOF.
        requireMp4(top);
        size = end - at;
      }
      if (kind === "uuid") header += 16;
      requireMp4(size >= header && at + size <= end);
      yield { kind, data: at + header, end: at + size };
      at += size;
    }
  }
  children(box: Box): Generator<Box> {
    return this.boxes(box.data, box.end);
  }
  /** Keep unknown full-box layouts uncovered without guessing field offsets. */
  version(
    box: Box,
    supported: readonly number[],
    allowedFlags = 0,
  ): number | null {
    requireMp4(box.data + 4 <= box.end);
    const version = this.reader.u8(box.data);
    if (
      !supported.includes(version) ||
      ((this.reader.u8(box.data + 1) * 65_536 +
        this.reader.u16be(box.data + 2)) &
        ~allowedFlags) !==
        0
    ) {
      this.uncovered = true;
      return null;
    }
    return version;
  }
  clock(box: Box): Clock | null {
    const version = this.version(box, [0, 1]);
    if (version === null) return null;
    const length = version === 0 ? 24 : 36;
    requireMp4(box.data + length <= box.end);
    if (box.data + length !== box.end) this.uncovered = true;
    const at = box.data + (version === 0 ? 12 : 20);
    const scale = this.reader.u32be(at);
    const ticks =
      version === 0 ? BigInt(this.reader.u32be(at + 4)) : this.u64(at + 4);
    const sentinel = version === 0 ? 0xffff_ffffn : 0xffff_ffff_ffff_ffffn;
    // Zero/unknown time has no invented sample rate or huge sentinel duration.
    if (scale === 0 || ticks === 0n || ticks === sentinel) {
      this.uncovered = true;
      return { scale, ticks: null };
    }
    return { scale, ticks };
  }
  timeline(box: Box): Timeline | null {
    if (this.version(box, [0]) === null) return null;
    requireMp4(box.data + 8 <= box.end);
    const count = this.reader.u32be(box.data + 4);
    requireMp4(box.data + 8 + count * 8 === box.end);
    this.record(count);
    let ticks = 0n;
    let partial = count === 0;
    for (let at = box.data + 8; at < box.end; at += 8) {
      const samples = this.reader.u32be(at);
      const delta = this.reader.u32be(at + 4);
      if (samples === 0 || delta === 0) partial = true;
      ticks += BigInt(samples) * BigInt(delta);
    }
    return { ticks, partial };
  }
  overBudget(ticks: bigint | null, scale: number): boolean {
    return (
      ticks !== null &&
      scale > 0 &&
      ticks > BigInt(scale) * BigInt(MAX_MESSAGE_AUDIO_SECONDS)
    );
  }
}

function unique(previous: Box | undefined, next: Box): Box {
  requireMp4(previous === undefined);
  return next;
}

function audioTrack(context: Mp4AudioContext, track: Box): void {
  let media: Box | undefined;
  for (const box of context.children(track)) {
    if (box.kind === "mdia") media = unique(media, box);
    // Edits may repeat, trim or change presentation rate. This slice does not
    // subtract them from independently known stored-media declarations.
    else if (box.kind === "edts") context.uncovered = true;
  }
  if (!media) {
    context.uncovered = true;
    return;
  }
  let header: Box | undefined;
  let handler: Box | undefined;
  let info: Box | undefined;
  for (const box of context.children(media)) {
    if (box.kind === "mdhd") header = unique(header, box);
    else if (box.kind === "hdlr") handler = unique(handler, box);
    else if (box.kind === "minf") info = unique(info, box);
  }
  if (!handler || context.version(handler, [0]) === null) {
    context.uncovered = true;
    return;
  }
  requireMp4(handler.data + 24 <= handler.end);
  if (context.text(handler.data + 8) !== "soun") return;
  context.audioTracks++;
  const clock = header ? context.clock(header) : null;
  if (clock && context.overBudget(clock.ticks, clock.scale))
    throw new Mp4AudioError("audioTooLong");
  let table: Box | undefined;
  if (info)
    for (const box of context.children(info))
      if (box.kind === "stbl") table = unique(table, box);
  let time: Box | undefined;
  if (table)
    for (const box of context.children(table))
      if (box.kind === "stts") time = unique(time, box);
  const timeline = time ? context.timeline(time) : null;
  if (clock && timeline && context.overBudget(timeline.ticks, clock.scale))
    throw new Mp4AudioError("audioTooLong");
  if (
    !clock ||
    clock.ticks === null ||
    !timeline ||
    timeline.partial ||
    timeline.ticks !== clock.ticks
  )
    context.uncovered = true;
}

/** Selected ISO/M4A audio-track declaration admission. Caller first checks
 * canonical Base64 and bytes. Only soun media clocks and sample durations count;
 * tracks/channels are not multiplied into elapsed duration. BigInt comparisons
 * retain 64-bit ticks without rounding. Edits, fragments and unknown timing
 * remain uncovered but cannot hide an independently known over-budget track.
 * This is not codec conformance, exact trimmed playback or decoder-memory proof.
 * Sources: Apple QTFF Atoms, Media header, Handler reference, Time-to-sample,
 * Playing with edit lists and AAC encoding background; see MP4 design evidence.
 */
export function messageMp4AudioAdmission(
  data: string,
): MessageMp4AudioAdmission {
  const reader = new MessageRasterReader(data);
  if (!reader.matches(4, "ftyp")) return "notMp4Audio";
  try {
    const context = new Mp4AudioContext(reader);
    let fileType: Box | undefined;
    let movie: Box | undefined;
    const fragments: Box[] = [];
    let mediaData = false;
    for (const box of context.boxes(0, reader.length, true)) {
      if (box.kind === "ftyp") {
        fileType = unique(fileType, box);
        requireMp4(box.data + 8 <= box.end && (box.end - box.data) % 4 === 0);
        context.record((box.end - box.data) / 4 - 1);
        let knownBrand = false;
        for (let at = box.data; at < box.end; at += 4) {
          if (at === box.data + 4) continue; // minor version is not a brand
          const brand = context.text(at);
          if (["M4A ", "M4B ", "mp41", "mp42", "isom"].includes(brand))
            knownBrand = true;
        }
        if (!knownBrand) context.uncovered = true;
      } else if (box.kind === "moov") movie = unique(movie, box);
      else if (box.kind === "mdat") mediaData = true;
      else if (box.kind === "moof") {
        context.uncovered = true;
        fragments.push(box);
      }
    }
    if (!fileType || !movie) return "notCovered";
    for (const box of context.children(movie)) {
      if (box.kind === "trak") audioTrack(context, box);
      else if (box.kind === "mvex") context.uncovered = true;
    }
    if (fragments.length) mp4FragmentBudgets(context, movie, fragments);
    return context.uncovered || !context.audioTracks || !mediaData
      ? "notCovered"
      : "withinBudget";
  } catch (error) {
    if (error instanceof Mp4AudioError) return error.reason;
    if (error instanceof MessageRasterError) return "invalid";
    throw error;
  }
}
