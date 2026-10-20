import {
  AvifContext,
  AvifCursor,
  type AvifBox,
  type AvifDimensions,
} from "./message_avif_reader";
import { rasterRecord, rasterRequire } from "./message_raster_reader";
import { avifLayers, type AvifLayers } from "./message_avif_layers";

interface Item {
  kind?: string;
  size?: AvifDimensions;
  associations?: number[];
  extents?: { offset: number; length: number }[];
  method?: number;
  uncertainLocation?: boolean;
  auxiliary?: boolean;
  unknownDimensions?: boolean;
  grid?: { rows: number; columns: number };
  layers?: AvifLayers;
  dimg: number[];
}

/** HEIF item declarations, not AV1 payload parsing. Property lookup is indexed;
 * each association/reference/extent consumes the same finite traversal budget. */
export function avifItems(context: AvifContext, meta: AvifBox): void {
  const reader = context.reader;
  const header = new AvifCursor(context, meta).full();
  if (header.version || header.flags) {
    context.uncovered = true;
    return;
  }
  const items = new Map<number, Item>();
  const properties: (AvifDimensions | undefined)[] = [undefined];
  const layerProperties = new Map<number, AvifLayers>();
  const associations: AvifBox[] = [];
  const associatedProperties = new Set<number>();
  const unknownDimensions = new Set<number>();
  let idat: AvifBox | undefined;
  let unknownInfo = false;
  let unknownAssociations = false;
  const seen = new Set<string>();
  const item = (id: number): Item => {
    rasterRequire(id > 0);
    let value = items.get(id);
    if (!value) {
      context.record();
      value = { dimg: [] };
      items.set(id, value);
    }
    return value;
  };
  const supported = (cursor: AvifCursor, versions: number[], mask = 0) => {
    const { version, flags } = cursor.full();
    if (!versions.includes(version) || flags & ~mask) {
      context.uncovered = true;
      return null;
    }
    return { version, flags };
  };
  const info = (box: AvifBox) => {
    const cursor = new AvifCursor(context, box);
    const full = supported(cursor, [0, 1]);
    if (!full) {
      unknownInfo = true;
      return;
    }
    const count = cursor.uint(full.version ? 4 : 2);
    context.record(count);
    let entries = 0;
    for (const entry of context.boxes(cursor.at, box.end, box.depth + 1)) {
      // AVIF9.1.2 permits these opaque boxes at every hierarchy level. The
      // shared iterator still checks and charges each box before we skip it.
      if (entry.kind === "free" || entry.kind === "skip") continue;
      rasterRequire(entry.kind === "infe");
      entries++;
      const fields = new AvifCursor(context, entry);
      const version = supported(fields, [2, 3], 1);
      if (!version) {
        unknownInfo = true;
        continue;
      }
      const value = item(fields.uint(version.version === 2 ? 2 : 4));
      rasterRequire(!value.kind);
      if (fields.uint(2)) context.uncovered = true; // Protected item, not decrypted here.
      fields.skip(4);
      value.kind = context.text(fields.at - 4);
      // Names and metadata content types are opaque; never scan/copy their text.
    }
    rasterRequire(entries === count);
  };
  const locations = (box: AvifBox) => {
    const cursor = new AvifCursor(context, box);
    const full = supported(cursor, [0, 1, 2]);
    if (!full) return;
    const sizes = cursor.uint(1),
      baseAndIndex = cursor.uint(1);
    const offsetBytes = sizes >>> 4,
      lengthBytes = sizes & 15;
    const baseBytes = baseAndIndex >>> 4;
    const indexBytes = full.version ? baseAndIndex & 15 : 0;
    rasterRequire(
      Math.max(offsetBytes, lengthBytes, baseBytes, indexBytes) <= 8,
    );
    const count = cursor.uint(full.version < 2 ? 2 : 4);
    context.record(count);
    for (let index = 0; index < count; index++) {
      const value = item(cursor.uint(full.version < 2 ? 2 : 4));
      rasterRequire(!value.extents);
      value.method = full.version ? cursor.uint(2) : 0;
      rasterRequire(value.method <= 15);
      const reference = cursor.uint(2);
      const base = cursor.uint(baseBytes);
      const extentCount = cursor.uint(2);
      context.record(extentCount);
      value.extents = [];
      value.uncertainLocation =
        reference !== 0 || value.method > 1 || !lengthBytes;
      if (value.uncertainLocation) context.uncovered = true;
      for (let extent = 0; extent < extentCount; extent++) {
        cursor.uint(indexBytes);
        const offset = base + cursor.uint(offsetBytes);
        const length = cursor.uint(lengthBytes);
        rasterRequire(Number.isSafeInteger(offset));
        value.extents.push({ offset, length });
      }
    }
    cursor.done();
  };
  const references = (box: AvifBox) => {
    const cursor = new AvifCursor(context, box);
    const full = supported(cursor, [0, 1]);
    if (!full) return;
    const bytes = full.version ? 4 : 2;
    for (const reference of context.boxes(cursor.at, box.end, box.depth + 1)) {
      if (!["dimg", "auxl", "thmb", "cdsc", "prem"].includes(reference.kind))
        continue;
      const fields = new AvifCursor(context, reference);
      const from = item(fields.uint(bytes));
      const count = fields.uint(2);
      context.record(count);
      if (reference.kind === "auxl") from.auxiliary = true;
      for (let index = 0; index < count; index++) {
        const target = fields.uint(bytes);
        item(target);
        if (reference.kind === "dimg") from.dimg.push(target);
      }
      fields.done();
    }
  };
  const propertyContainer = (box: AvifBox) => {
    for (const property of context.children(box)) {
      let size: AvifDimensions | undefined;
      if (property.kind === "ispe") {
        const cursor = new AvifCursor(context, property);
        if (supported(cursor, [0])) {
          const width = cursor.uint(4),
            height = cursor.uint(4);
          rasterRequire(width > 0 && height > 0);
          size = { width, height };
          cursor.done();
        } else unknownDimensions.add(properties.length);
      } else if (property.kind === "a1lx") {
        const layers = avifLayers(context, property);
        if (layers) layerProperties.set(properties.length, layers);
      } else if (
        ![
          "av1C",
          "pixi",
          "colr",
          "clap",
          "irot",
          "imir",
          "auxC",
          "a1op",
          "lsel",
          "clli",
          "mdcv",
          "cclv",
          "ccst",
          "pasp",
        ].includes(property.kind)
      )
        context.uncovered = true; // Unknown extensions keep their previous support.
      properties.push(size);
    }
  };
  for (const box of context.children(meta, 4)) {
    if (!["iinf", "iloc", "iprp", "iref", "idat"].includes(box.kind)) continue;
    rasterRequire(!seen.has(box.kind));
    seen.add(box.kind);
    if (box.kind === "iinf") info(box);
    else if (box.kind === "iloc") locations(box);
    else if (box.kind === "iref") references(box);
    else if (box.kind === "idat") idat = box;
    else {
      let containerSeen = false;
      for (const propertyBox of context.children(box)) {
        if (propertyBox.kind === "ipco") {
          rasterRequire(!containerSeen);
          containerSeen = true;
          propertyContainer(propertyBox);
        } else if (propertyBox.kind === "ipma") associations.push(propertyBox);
      }
    }
  }
  for (const box of associations) {
    const cursor = new AvifCursor(context, box);
    const full = supported(cursor, [0, 1], 1);
    if (!full) {
      unknownInfo = true;
      unknownAssociations = true;
      continue;
    }
    const count = cursor.uint(4);
    context.record(count);
    let previous = 0;
    for (let index = 0; index < count; index++) {
      const id = cursor.uint(full.version ? 4 : 2);
      rasterRequire(id > previous);
      previous = id;
      const value = item(id);
      rasterRequire(!value.associations);
      value.associations = [];
      const number = cursor.uint(1);
      context.record(number);
      for (let property = 0; property < number; property++) {
        const wide = !!(full.flags & 1),
          encoded = cursor.uint(wide ? 2 : 1);
        const key = encoded & (wide ? 0x7fff : 0x7f);
        rasterRequire(key < properties.length && (key || !encoded));
        if (!key) continue;
        value.associations.push(key);
        associatedProperties.add(key);
        const layers = layerProperties.get(key);
        if (layers) {
          rasterRequire(!value.layers);
          value.layers = layers;
        }
        if (unknownDimensions.has(key)) value.unknownDimensions = true;
        const size = properties[key];
        if (size) {
          rasterRequire(!value.size);
          value.size = size;
        }
      }
    }
    cursor.done();
  }
  // A property does not describe an image until ipma associates it. Keep the
  // canvas gate for every known associated size; unused properties still had
  // their structure and records checked above. Unknown association layouts
  // cannot establish that a property is unused, so retain their prior gate.
  for (let key = 1; key < properties.length; key++) {
    const size = properties[key];
    if (size && (unknownAssociations || associatedProperties.has(key)))
      context.dimensions(size.width, size.height);
  }
  // Definite local ranges apply to coded/auxiliary items as well as grids.
  // Unknown addressing keeps its prior coverage; no item payload is decoded.
  for (const value of items.values()) {
    if (value.uncertainLocation || !value.extents) continue;
    let limit = reader.length;
    if (value.method === 1) {
      rasterRequire(idat);
      limit = idat.end - idat.data;
    }
    for (const extent of value.extents)
      rasterRequire(
        extent.offset <= limit && extent.length <= limit - extent.offset,
      );
  }
  // All item lookups and graph work are linear in charged records. Reusing one
  // ispe does not make thousands of image items cost one image's pixels.
  const incoming = new Map<number, number>(),
    uses = new Map<number, number>();
  for (const [id, value] of items) {
    incoming.set(id, incoming.get(id) ?? 0);
    for (const target of value.dimg)
      incoming.set(target, (incoming.get(target) ?? 0) + 1);
  }
  const queue: number[] = [];
  for (const [id, count] of incoming)
    if (!count) {
      queue.push(id);
      uses.set(id, 1);
    }
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index],
      value = items.get(id)!;
    if (!value.kind) {
      if (unknownInfo) context.uncovered = true;
      else rasterRequire(false);
    }
    if (value.kind === "grid") {
      if (value.uncertainLocation) context.uncovered = true;
      else {
        rasterRequire(
          value.extents?.length && (value.size || value.unknownDimensions),
        );
        const prefix = new Uint8Array(12);
        let filled = 0;
        for (const extent of value.extents) {
          let offset = extent.offset,
            limit = reader.length;
          if (value.method === 1) {
            rasterRequire(idat);
            offset += idat.data;
            limit = idat.end;
          }
          rasterRequire(offset + extent.length <= limit);
          reader.require(offset, extent.length);
          const take = Math.min(prefix.length - filled, extent.length);
          for (let at = 0; at < take; at++)
            prefix[filled++] = reader.u8(offset + at);
        }
        if (prefix[0] || prefix[1] > 1) context.uncovered = true;
        else {
          const wide = !!prefix[1],
            needed = wide ? 12 : 8;
          rasterRequire(filled >= needed);
          const view = new DataView(prefix.buffer);
          const width = wide ? view.getUint32(4) : view.getUint16(4);
          const height = wide ? view.getUint32(8) : view.getUint16(6);
          const size = context.dimensions(width, height);
          if (value.size)
            rasterRequire(
              width === value.size.width && height === value.size.height,
            );
          else value.size = size;
          value.grid = { rows: prefix[2] + 1, columns: prefix[3] + 1 };
          rasterRequire(
            value.dimg.length === value.grid.rows * value.grid.columns,
          );
        }
      }
    } else if (value.kind === "av01" && !value.size) {
      if (value.auxiliary || unknownInfo || value.unknownDimensions)
        context.uncovered = true;
      else rasterRequire(false);
    } else if (
      value.kind &&
      !["av01", "Exif", "mime", "uri "].includes(value.kind)
    )
      context.uncovered = true; // New derived image types keep their old support.
    const copies = uses.get(id) ?? 1;
    if (
      value.layers &&
      !value.uncertainLocation &&
      value.extents?.length &&
      value.extents.every((extent) => extent.length > 0)
    ) {
      // Only definite local/file or idat lengths can locate the final layer.
      // External references, item-offset construction and unspecified lengths
      // retain their old unknown coverage rather than pretending exact bytes.
      const length = value.extents.reduce(
        (sum, extent) => sum + extent.length,
        0,
      );
      rasterRequire(
        Number.isSafeInteger(length) && value.layers.precedingBytes < length,
      );
    }
    if (value.size)
      context.charge(value.size, copies * (value.layers?.count ?? 1));
    for (const target of value.dimg) {
      const number = (uses.get(target) ?? 0) + copies;
      rasterRecord(number);
      uses.set(target, number);
      const remaining = incoming.get(target)! - 1;
      incoming.set(target, remaining);
      if (!remaining) queue.push(target);
    }
  }
  rasterRequire(queue.length === items.size); // Cyclic image derivation, never recurse.
  rasterRequire(items.size || context.uncovered);
  for (const value of items.values()) {
    if (!value.grid || !value.size) continue;
    let tile: AvifDimensions | undefined;
    for (const id of value.dimg) {
      const current = items.get(id)!.size;
      if (!current) {
        context.uncovered = true;
        continue;
      }
      if (tile)
        rasterRequire(
          current.width === tile.width && current.height === tile.height,
        );
      else tile = current;
    }
    if (tile) {
      const { rows, columns } = value.grid;
      rasterRequire(
        tile.width * (columns - 1) < value.size.width &&
          value.size.width <= tile.width * columns,
      );
      rasterRequire(
        tile.height * (rows - 1) < value.size.height &&
          value.size.height <= tile.height * rows,
      );
    }
  }
}
