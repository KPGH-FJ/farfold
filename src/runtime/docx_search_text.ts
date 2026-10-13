import {
  DOCX_LIMITS,
  DocxError,
  type DocxBlock,
  type DocxDocument,
  type DocxSourcePosition,
  type DocxStory,
  type DocxWarning,
} from "./docx_types";

export interface DocxSearchLocation {
  readonly region: "body" | DocxStory["kind"];
  readonly regionIndex: number;
  readonly noteId?: string;
  readonly paragraph: number;
  readonly cells: readonly Readonly<{
    table: number;
    row: number;
    column: number;
  }>[];
  readonly source: DocxSourcePosition;
}
export interface DocxSearchSegment {
  readonly text: string;
  readonly location: DocxSearchLocation;
}
export interface DocxSearchScope {
  readonly partial: boolean;
  readonly warnings: readonly DocxWarning[];
  readonly imageReferences: number;
}
export interface DocxSearchText {
  readonly segments: readonly DocxSearchSegment[];
  readonly bytes: number;
  readonly document: DocxSearchScope;
}

/** Only validated author text. Labels, placeholders and package keys never enter it. */
export function docxSearchText(document: DocxDocument): DocxSearchText {
  const segments: DocxSearchSegment[] = [];
  let bytes = 0,
    chars = 0,
    images = 0;
  const encoder = new TextEncoder();
  const walk = (
    blocks: readonly DocxBlock[],
    region: Pick<DocxSearchLocation, "region" | "regionIndex" | "noteId">,
    cells: DocxSearchLocation["cells"],
  ) => {
    let paragraph = 0,
      table = 0;
    for (const block of blocks) {
      if (block.kind === "notice") continue;
      if (block.kind === "table") {
        table++;
        block.rows.forEach((row, index) =>
          row.cells.forEach((cell) => {
            // Merged continuations are absent from the validated structure.
            walk(
              cell.blocks,
              region,
              Object.freeze([
                ...cells,
                Object.freeze({
                  table,
                  row: index + 1,
                  column: cell.column + 1,
                }),
              ]),
            );
          }),
        );
        continue;
      }
      paragraph++;
      const location: DocxSearchLocation = Object.freeze({
        ...region,
        paragraph,
        cells,
        source: Object.freeze({
          part: block.source.part,
          elementPath: Object.freeze([...block.source.elementPath]),
        }),
      });
      let parts: string[] = [];
      const flush = () => {
        const text = parts.join("");
        parts = [];
        if (!text) return;
        chars += text.length;
        if (chars > DOCX_LIMITS.text || segments.length >= DOCX_LIMITS.runs)
          throw new DocxError("limit");
        if (
          text.includes("\0") ||
          /[\uD800-\uDFFF]/u.test(
            text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""),
          )
        )
          throw new DocxError("invalid");
        bytes += encoder.encode(text).length;
        segments.push(Object.freeze({ text, location }));
      };
      for (const run of block.runs) {
        if (run.kind === "text") parts.push(run.text);
        else if (run.kind === "tab") parts.push("\t");
        else if (run.kind === "break") parts.push("\n");
        else {
          // Unknown/omitted content is a barrier, not an empty string that
          // could join unrelated author words across a missing object.
          flush();
          if (run.kind === "image") images++;
        }
      }
      flush();
    }
  };
  walk(document.blocks, { region: "body", regionIndex: 0 }, Object.freeze([]));
  const storyCounts = new Map<DocxStory["kind"], number>();
  for (const story of document.stories) {
    const regionIndex = (storyCounts.get(story.kind) ?? 0) + 1;
    storyCounts.set(story.kind, regionIndex);
    walk(
      story.blocks,
      {
        region: story.kind,
        regionIndex,
        ...(story.noteId !== undefined ? { noteId: story.noteId } : {}),
      },
      Object.freeze([]),
    );
  }
  return Object.freeze({
    segments: Object.freeze(segments),
    bytes,
    document: Object.freeze({
      partial: document.partial || images > 0,
      warnings: Object.freeze(
        document.warnings.map((w) => Object.freeze({ ...w })),
      ),
      imageReferences: images,
    }),
  });
}
