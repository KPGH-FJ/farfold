// Synthetic container declarations only. These are never passed to a decoder.
export function u16(value: number): Buffer {
  const data = Buffer.alloc(2);
  data.writeUInt16BE(value);
  return data;
}
export function u32(value: number): Buffer {
  const data = Buffer.alloc(4);
  data.writeUInt32BE(value);
  return data;
}
export function avifBox(kind: string, ...payload: Buffer[]): Buffer {
  const data = Buffer.concat(payload);
  return Buffer.concat([u32(data.length + 8), Buffer.from(kind), data]);
}
export function avifFull(
  kind: string,
  version: number,
  flags: number,
  ...payload: Buffer[]
): Buffer {
  const header = u32(flags);
  header[0] = version;
  return avifBox(kind, header, ...payload);
}
export const AVIF_FTYP = avifBox(
  "ftyp",
  Buffer.from("avif"),
  u32(0),
  Buffer.from("avif"),
);
export function avifFile(...boxes: Buffer[]): string {
  return Buffer.concat([AVIF_FTYP, ...boxes]).toString("base64");
}
export function avifIspe(width: number, height: number): Buffer {
  return avifFull("ispe", 0, 0, u32(width), u32(height));
}
export interface SyntheticAvifItem {
  id: number;
  kind?: string;
  properties?: number[];
  references?: number[];
  grid?: Buffer;
  auxiliary?: number;
}
export function avifMeta(
  items: SyntheticAvifItem[],
  properties: Buffer[],
  extra: Buffer[] = [],
): Buffer {
  let offset = 0;
  const payloads: Buffer[] = [],
    locations: Buffer[] = [],
    references: Buffer[] = [];
  for (const item of items) {
    if (item.grid) {
      payloads.push(item.grid);
      locations.push(
        Buffer.concat([
          u16(item.id),
          u16(1),
          u16(0),
          u16(1),
          u32(offset),
          u32(item.grid.length),
        ]),
      );
      offset += item.grid.length;
    }
    if (item.references)
      references.push(
        avifBox(
          "dimg",
          u16(item.id),
          u16(item.references.length),
          ...item.references.map(u16),
        ),
      );
    if (item.auxiliary)
      references.push(
        avifBox("auxl", u16(item.id), u16(1), u16(item.auxiliary)),
      );
  }
  return avifFull(
    "meta",
    0,
    0,
    avifFull("pitm", 0, 0, u16(items[0]?.id ?? 1)),
    avifFull(
      "iinf",
      0,
      0,
      u16(items.length),
      ...items.map((item) =>
        avifFull(
          "infe",
          2,
          0,
          u16(item.id),
          u16(0),
          Buffer.from(item.kind ?? "av01"),
          Buffer.from([0]),
        ),
      ),
    ),
    ...(locations.length
      ? [
          avifFull(
            "iloc",
            1,
            0,
            Buffer.from([0x44, 0]),
            u16(locations.length),
            ...locations,
          ),
        ]
      : []),
    ...(references.length ? [avifFull("iref", 0, 0, ...references)] : []),
    avifBox(
      "iprp",
      avifBox("ipco", ...properties),
      avifFull(
        "ipma",
        0,
        0,
        u32(items.length),
        ...items.map((item) =>
          Buffer.concat([
            u16(item.id),
            Buffer.from([
              item.properties?.length ?? 0,
              ...(item.properties ?? []),
            ]),
          ]),
        ),
      ),
    ),
    ...(payloads.length ? [avifBox("idat", ...payloads)] : []),
    ...extra,
  );
}
export function avifGrid(
  width: number,
  height: number,
  rows = 1,
  columns = 1,
  wide = false,
): Buffer {
  return Buffer.concat([
    Buffer.from([0, wide ? 1 : 0, rows - 1, columns - 1]),
    ...(wide ? [u32(width), u32(height)] : [u16(width), u16(height)]),
  ]);
}
export function avifTrack(
  width: number,
  height: number,
  samples: number,
  options: {
    id?: number;
    timedSamples?: number;
    sampleBox?: Buffer;
    tkhd?: Buffer;
    stsd?: Buffer;
    handler?: string;
  } = {},
): Buffer {
  const head = Buffer.alloc(80);
  head.writeUInt32BE(options.id ?? 1, 8);
  head.writeUInt32BE(width * 65_536, 72);
  head.writeUInt32BE(height * 65_536, 76);
  const sample = Buffer.alloc(78);
  sample.writeUInt16BE(width, 24);
  sample.writeUInt16BE(height, 26);
  return avifBox(
    "trak",
    options.tkhd ?? avifFull("tkhd", 0, 3, head),
    avifBox(
      "mdia",
      ...(options.handler
        ? [
            avifFull(
              "hdlr",
              0,
              0,
              u32(0),
              Buffer.from(options.handler),
              Buffer.alloc(12),
            ),
          ]
        : []),
      avifBox(
        "minf",
        avifBox(
          "stbl",
          options.stsd ??
            avifFull("stsd", 0, 0, u32(1), avifBox("av01", sample)),
          options.sampleBox ?? avifFull("stsz", 0, 0, u32(1), u32(samples)),
          avifFull(
            "stts",
            0,
            0,
            u32(1),
            u32(options.timedSamples ?? samples),
            u32(1),
          ),
        ),
      ),
    ),
  );
}
