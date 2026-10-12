import type {
  DocxBlock,
  DocxDocument,
  DocxParagraph,
  DocxRun,
} from "./docx_types";
import { DOCUMENT_WARNINGS } from "./document_strings";
import { DOCUMENT_INPUT_STRINGS as S } from "./document_input_strings";
import {
  DOCUMENT_INPUT_MAX_BYTES,
  documentTextBytes,
} from "./document_input_types";

export interface DocxInputText {
  text: string;
  actualTextChars: number;
  imageReferences: number;
}

/** Consume complete validated structure, never presentation windows or excerpts. */
export function docxInputText(document: DocxDocument): DocxInputText {
  let actualTextChars = 0,
    imageReferences = 0;
  const runs = (items: DocxRun[]): string =>
    items
      .map((run) => {
        switch (run.kind) {
          case "text":
            actualTextChars += run.text.replace(/\s/g, "").length;
            return run.text;
          case "tab":
            return "\t";
          case "break":
            return run.page ? "\n[手动分页]\n" : "\n";
          case "noteReference":
            return `[${run.noteKind === "footnote" ? "脚注" : "尾注"}位置 ${run.noteId}]`;
          case "image":
            imageReferences++;
            return run.alt
              ? `[图片未加入；作者替代文字：${JSON.stringify(run.alt)}]`
              : "[图片未加入]";
          case "notice":
            return `[未加入：${DOCUMENT_WARNINGS[run.code]}]`;
        }
      })
      .join("");
  const paragraph = (block: DocxParagraph) => ({
    kind: "paragraph",
    text: runs(block.runs),
    ...(block.headingLevel !== undefined
      ? { headingLevel: block.headingLevel }
      : {}),
    ...(block.list ? { list: { ...block.list } } : {}),
  });
  type TextBlock =
    | ReturnType<typeof paragraph>
    | {
        kind: "table";
        columns: number;
        rows: {
          cells: {
            column: number;
            rowSpan: number;
            columnSpan: number;
            blocks: TextBlock[];
          }[];
        }[];
      }
    | { kind: "omitted"; reason: string };
  const structured = (block: DocxBlock): TextBlock => {
    if (block.kind === "paragraph") return paragraph(block);
    if (block.kind === "notice")
      return { kind: "omitted", reason: DOCUMENT_WARNINGS[block.code] };
    return {
      kind: "table",
      columns: block.columnsPt.length,
      rows: block.rows.map((row) => ({
        cells: row.cells.map((cell) => ({
          column: cell.column + 1,
          rowSpan: cell.rowSpan,
          columnSpan: cell.columnSpan,
          blocks: cell.blocks.map(structured),
        })),
      })),
    };
  };
  const render = (blocks: DocxBlock[]): string =>
    blocks
      .map((block) => {
        if (block.kind === "paragraph") {
          const value = paragraph(block);
          return `${block.headingLevel !== undefined ? `[标题 ${block.headingLevel}]\n` : ""}${block.list ? `${block.list.label}\t` : ""}${value.text}`;
        }
        if (block.kind === "notice")
          return `[未加入：${DOCUMENT_WARNINGS[block.code]}]`;
        // JSON preserves literal newlines/quotes/pipes and explicit merge anchors.
        // Row/column positions are one-based; continuation cells are not duplicated.
        return `[表格；行列从 1 开始]\n${JSON.stringify(structured(block))}`;
      })
      .join("\n\n");
  const sections = [
    "文档文字（文件保存时的已读取内容）",
    S.scope,
    ...(document.partial ? [S.scopePartial] : []),
    ...document.warnings.map(
      (warning) => `${DOCUMENT_WARNINGS[warning.code]}（${warning.count}处）`,
    ),
    "【正文】",
    render(document.blocks),
    ...document.stories.map((story) => {
      const title = {
        header: "页眉",
        footer: "页脚",
        footnote: "脚注",
        endnote: "尾注",
      }[story.kind];
      return `【${title}${story.noteId !== undefined ? ` ${story.noteId}` : ""}】\n${render(story.blocks)}`;
    }),
  ];
  const text = sections.join("\n\n");
  documentTextBytes(text, DOCUMENT_INPUT_MAX_BYTES);
  return { text, actualTextChars, imageReferences };
}
