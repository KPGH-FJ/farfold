import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));

it("recovers an opinion-only prepared conversation from its saved owner", async () => {
  const formerOwner = "example:/work:old-preparation";
  const currentOwner = "example:/work:new-preparation";
  const path = "/work/source.md";
  const sha = "a".repeat(64);
  const opinion = {
    path,
    contentId: `disk:${JSON.stringify([path, "original", sha])}`,
    text: "  exact retained opinion\n",
    selection: null,
    scope: "file",
    anchor: {
      kind: "text-range",
      byteStart: 6,
      byteEnd: 16,
      startLine: 2,
      endLine: 2,
    },
  };
  h.invoke.mockResolvedValueOnce({
    version: 1,
    composers: {},
    choice: { agentId: null, cwd: null, service: null, config: {} },
    feedback: {
      [formerOwner]: { saved: opinion },
      [currentOwner]: { saved: { ...opinion, text: "CURRENT OWNER" } },
    },
    queues: {},
  });
  const { PreservedDrafts } = await import("./PreservedDrafts");
  const { draftPersistence, fileFeedbackDrafts } =
    await import("../runtime/drafts");
  await draftPersistence.load();
  expect(Object.values(fileFeedbackDrafts.entries(formerOwner))).toEqual([
    opinion,
  ]);
  const options = {
    onRestore: vi.fn(),
    availableFeedbackOwners: new Set([currentOwner]),
  };
  expect(
    renderToStaticMarkup(<PreservedDrafts onRestore={options.onRestore} />),
  ).toBe("");
  const html = renderToStaticMarkup(<PreservedDrafts {...options} />);
  expect(html).toContain("找不到原对话的文件意见");
  expect(html).toContain(path);
  expect(html).toContain(sha);
  expect(html).toContain("第 2 行");
  expect(html).toContain("  exact retained opinion\n");
  expect(html).toContain("复制意见");
  expect(html).not.toContain("CURRENT OWNER");
  expect(html).not.toContain("加入输入框");
  expect(
    renderToStaticMarkup(
      <PreservedDrafts
        {...options}
        availableFeedbackOwners={new Set([formerOwner, currentOwner])}
      />,
    ),
  ).toBe("");
  expect(options.onRestore).not.toHaveBeenCalled();
  expect(h.invoke).toHaveBeenCalledTimes(1);
});
