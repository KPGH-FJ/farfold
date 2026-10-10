import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../runtime/setup_storage", () => ({
  useSetupStorage: () => ({}),
  setupStorage: { completed: () => false, confirmedSelection: () => null },
}));
import { EmptyState } from "./EmptyState";

it("offers explicit worktree management from a folderless draft without an Agent", () => {
  const html = renderToStaticMarkup(
    <EmptyState
      agents={[]}
      onGoSettings={() => {}}
      onProjectChange={() => {}}
      onStarted={() => {}}
    />,
  );
  expect(html).toContain('aria-label="工作树"');
});
