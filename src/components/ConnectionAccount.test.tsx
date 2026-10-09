import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountIdentity } from "../runtime/agents";
const h = vi.hoisted(() => ({ account: null as AccountIdentity | null }));
vi.mock("../runtime/connection_account", () => ({
  useConnectionAccount: () => h.account,
}));
import { ConnectionAccount } from "./ConnectionAccount";
import { AGENT_REDESIGN as U } from "../runtime/agent_redesign_strings";
const html = (source?: string) =>
  renderToStaticMarkup(
    <ConnectionAccount agentId="example" cwd="/work" active source={source} />,
  );

it("keeps missing identity separate from credential presence or login state", () => {
  h.account = { kind: "credential" };
  const markup = html();
  expect(markup).toContain(U.identityUnknown);
  expect(markup).toContain("已检测到登录资料");
  expect(markup).toContain(U.identityUnknownHint);
  expect(markup).not.toContain(">未登录<");
});

it("shows only reported personal and plan fields and never substitutes them into a chosen API service", () => {
  h.account = {
    kind: "account",
    email: "person@example.test",
    displayName: "Test person",
    plan: "Test plan",
  };
  const markup = html();
  expect(markup).toContain("person@example.test · Test person");
  expect(markup).toContain("Test plan");
  expect(html("chosen-service")).toBe("");
  h.account = null;
  expect(html()).toContain(U.notRead);
});
