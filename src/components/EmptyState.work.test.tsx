import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const policy = vi.hoisted(() => ({
  enabled: false,
  set: vi.fn(),
  retry: vi.fn(),
}));
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: (cwd: string | null) => ({
    ready: true,
    saving: false,
    error: null,
    cwd,
    enabled: () => policy.enabled,
    set: policy.set,
    retry: policy.retry,
  }),
}));
vi.mock("../runtime/setup_storage", () => ({
  useSetupStorage: () => ({}),
  setupStorage: {
    completed: () => true,
    confirmedSelection: () => ({ service: null, config: {} }),
  },
}));
import { EmptyState } from "./EmptyState";
import { composerDrafts, newConversationChoice } from "../runtime/drafts";
import type { AgentCardModel } from "../runtime/agents";
import { STRINGS } from "../runtime/strings";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";

const agent: AgentCardModel = {
  id: "registered-agent",
  name: "Registered Agent",
  description: "",
  status: "connected",
  version: null,
  authMethods: [],
  discoveredPath: null,
  registryVersion: null,
  source: null,
  installable: false,
  registerable: false,
  custom: false,
  handshake: null,
};
beforeEach(() => {
  policy.enabled = false;
  newConversationChoice.agentId = agent.id;
  newConversationChoice.cwd = "/test-work";
  newConversationChoice.service = null;
  newConversationChoice.config = {};
  composerDrafts.update("new", () => ({
    text: "Keep the selected agent and this text",
    attachments: [],
  }));
});
afterEach(() => {
  composerDrafts.clear("new");
  newConversationChoice.agentId = null;
  newConversationChoice.cwd = null;
});
function render(cards = [agent]) {
  return renderToStaticMarkup(
    <EmptyState
      agents={cards}
      onGoSettings={() => {}}
      onProjectChange={() => {}}
      onStarted={() => {}}
    />,
  );
}
it("keeps a prepared selected agent while its location is paused", () => {
  const html = render();
  expect(html).toContain(STRINGS.repair.workOff);
  expect(html).toContain(W.enableWork);
  expect(html).toContain("Keep the selected agent and this text");
  expect(html).toContain("Registered Agent");
  expect(html).not.toContain(W.prepareAgent);
  expect(html).not.toContain(W.prepareHint);
  expect(html).toContain(W.modelPaused);
  expect(html).not.toContain(W.modelPending);
  const modelButton = html.match(
    /<button[^>]*aria-label="模型与来源"[^>]*>/,
  )?.[0];
  expect(modelButton).toBeDefined();
  expect(modelButton).not.toContain("disabled");
  expect(html).toMatch(/aria-label="发送" disabled/);
});
it("does not keep pause guidance after sending is restored", () => {
  policy.enabled = true;
  const html = render();
  expect(html).not.toContain(STRINGS.repair.workOff);
  expect(html).not.toContain(W.modelPaused);
  expect(html).not.toContain(W.prepareAgent);
  expect(html).toContain("Registered Agent");
});
it("still directs a genuinely unprepared selected agent to preparation", () => {
  const html = render([{ ...agent, status: "discovered" }]);
  expect(html).toContain(W.prepareAgent);
  const modelButton = html.match(
    /<button[^>]*aria-label="模型与来源"[^>]*>/,
  )?.[0];
  expect(modelButton).toContain("disabled");
});
