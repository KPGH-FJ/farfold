import { expect, it } from "vitest";
import { TEXT_BLOCK_STRINGS as T } from "./text_block_strings";
import { FILE_COPY_STRINGS as C } from "./file_copy_strings";
const forbidden =
  /runtime|host|acp|原生|绑定|代次|投影|占用|working copy|session|turn|构建|引用|对账|沉降|上游|sidecar|adapter|握手|envelope/i;
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object")
    return Object.values(value).flatMap(strings);
  return [];
}
it("uses user-facing file vocabulary in static and formatted states", () => {
  const block = {
    file: {
      root: "/w",
      path: "a",
      resolvedPath: "/w/a",
      name: "a",
      size: 20,
      version: "1",
      sha256: "h",
    },
    blockIndex: 1,
    blockCount: 3,
    byteStart: 10,
    byteEnd: 15,
    startLine: 7,
    endLine: 8,
    startsMidLine: true,
    endsMidLine: true,
    text: "x",
  };
  for (const value of [
    ...strings(T),
    ...strings(C),
    T.range(block),
    T.continuation(block),
    C.progress(2, 3),
    C.activityCount(2),
  ])
    expect(value).not.toMatch(forbidden);
});
