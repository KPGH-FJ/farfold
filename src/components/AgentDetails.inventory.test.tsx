import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
import { AgentDetails } from "./AgentDetails";
import type { AgentCardModel, AgentsState } from "../runtime/agents";
import { EXTENSION_INVENTORY_STRINGS as S } from "../runtime/extension_inventory_strings";
it("places the shared inventory in Agent details and does not expose a query without a verified capability", () => {
  const card = {
    id: "fixture-unreviewed",
    name: "Fixture",
    description: "",
    status: "installed",
    version: null,
    authMethods: [],
    discoveredPath: null,
    registryVersion: null,
    source: "custom",
    installable: false,
    registerable: false,
    custom: true,
    handshake: null,
  } satisfies AgentCardModel;
  const agents = {
    errors: {},
    busy: {},
    extensionOwners: new Map(),
    loading: false,
    scanning: false,
  } as unknown as AgentsState;
  const html = renderToStaticMarkup(
    <AgentDetails
      card={card}
      agents={agents}
      active
      source="fixture"
      onClose={() => {}}
      onPrepare={() => {}}
    />,
  );
  expect(html).toContain(S.heading);
  expect(html).toContain(S.errors.entryUnverified);
  expect(html).toContain(S.unavailableLists);
  expect(html).toContain(S.limits);
  expect(html).not.toContain(S.query);
  expect(html).not.toContain(S.chooseDirectory);
});
