import { expect, it, vi } from "vitest";
import {
  CodexAdmissionPrivateView,
  checkedCodexAdmission,
  type CodexAdmissionCommand,
} from "./codex-acp-admission";
import type { CodexAcpScope } from "./codex-acp-contract";
const scope: CodexAcpScope = {
  runtimeProductId: "codex",
  installationId: "i",
  runtimeBuildId: "b",
  adapterId: "codex-acp-stdio-v1",
  adapterBuildId: "a",
  connectionId: "c",
  profileId: "p",
  generation: 1,
};
const model = {
  id: "catalog-id",
  model: "native-model",
  displayName: "Visible",
  description: "",
  hidden: false,
  isDefault: true,
  supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }],
  defaultReasoningEffort: "medium",
  inputModalities: ["text"],
};
const snapshot = () => ({
  scope,
  epoch: 2,
  account: { kind: "apiKey", requiresOpenaiAuth: true },
  catalog: [model, { ...model, id: "hidden", hidden: true }],
  catalogHash: "a".repeat(64),
  selection: null,
});
const choice = {
  catalogModelId: "catalog-id",
  nativeModel: "native-model",
  provider: "expected-provider",
  reasoningEffort: "medium",
};
const receipt = (s: unknown) => ({ kind: "admission", snapshot: s });
const command = (): CodexAdmissionCommand => ({
  action: "select",
  observationScope: scope,
  epoch: 2,
  catalogHash: "a".repeat(64),
  selection: choice,
});
function setup(allowed = true, bound = false) {
  const request = vi.fn().mockResolvedValue(receipt(snapshot()));
  let current = true;
  const view = new CodexAdmissionPrivateView(scope, () => ({
    allowed,
    bound,
    current: () => current,
    request,
  }));
  return {
    view,
    request,
    retire: () => {
      current = false;
    },
  };
}
it("never dispatches from closed production or selects without fresh explicit input", async () => {
  const a = setup(false);
  await a.view.refresh();
  await a.view.select(choice);
  expect(a.request).not.toHaveBeenCalled();
  const b = setup();
  await b.view.select(choice);
  expect(b.request).not.toHaveBeenCalled();
});
it("binds explicit selection to original scope epoch hash and keeps actual absent", async () => {
  const { view, request } = setup();
  await view.refresh();
  request.mockResolvedValue(receipt({ ...snapshot(), selection: choice }));
  await view.select(choice);
  expect(request).toHaveBeenLastCalledWith(scope, command());
  expect(view.getSnapshot().snapshot?.selection).toEqual(choice);
  expect(JSON.stringify(view.getSnapshot())).not.toContain("actual");
});
it("rejects every foreign scope field, stale version/hash, changed provider and catalog", () => {
  const original = snapshot();
  for (const field of Object.keys(scope))
    expect(() =>
      checkedCodexAdmission(
        receipt({
          ...original,
          scope: { ...scope, [field]: field === "generation" ? 2 : "foreign" },
        }),
        scope,
        { action: "refresh" },
        null,
      ),
    ).toThrow();
  for (const change of [
    { epoch: 3 },
    { catalogHash: "b".repeat(64) },
    { selection: { ...choice, provider: "foreign" } },
    { selection: { ...choice, nativeModel: "foreign" } },
    { catalog: [{ ...model, hidden: true }] },
  ])
    expect(() =>
      checkedCodexAdmission(
        receipt({ ...original, selection: choice, ...change }),
        scope,
        command(),
        original,
      ),
    ).toThrow();
});
it.each([
  { ...choice, catalogModelId: "hidden" },
  { ...choice, nativeModel: "wrong" },
  { ...choice, reasoningEffort: "unsupported" },
  { ...choice, provider: "" },
])("does not send invisible or inconsistent choices", async (bad) => {
  const { view, request } = setup();
  await view.refresh();
  await view.select(bad);
  expect(request).toHaveBeenCalledTimes(1);
  expect(view.getSnapshot().snapshot?.selection).toBeNull();
});
it("refresh failure clears catalog/selection and does not expose raw errors or retry", async () => {
  const { view, request } = setup();
  await view.refresh();
  request.mockRejectedValue(new Error("PRIVATE-RAW"));
  await view.refresh();
  await view.select(choice);
  expect(view.getSnapshot().snapshot).toBeNull();
  expect(JSON.stringify(view.getSnapshot())).not.toContain("PRIVATE-RAW");
  expect(request).toHaveBeenCalledTimes(2);
});
it("a later refresh cannot roll its observed version backward or change a hash within the same epoch", () => {
  for (const change of [{ epoch: 1 }, { catalogHash: "b".repeat(64) }])
    expect(() =>
      checkedCodexAdmission(
        receipt({ ...snapshot(), ...change }),
        scope,
        { action: "refresh" },
        snapshot(),
      ),
    ).toThrow();
});
it("pending selection clears current availability and late cross-generation success cannot return", async () => {
  const { view, request, retire } = setup();
  await view.refresh();
  let release!: (v: unknown) => void;
  request.mockImplementation(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const p = view.select(choice);
  expect(view.getSnapshot().snapshot).toBeNull();
  retire();
  view.retire();
  release(receipt({ ...snapshot(), selection: choice }));
  await p;
  expect(view.getSnapshot().snapshot).toBeNull();
});
it("bound Session can read but cannot replace immutable selection", async () => {
  const { view, request } = setup(true, true);
  await view.refresh();
  await view.select(choice);
  expect(request).toHaveBeenCalledTimes(1);
});
it("never revives previous selection on refresh and rejects actual or incomplete/oversized catalogs", () => {
  for (const change of [
    { selection: choice },
    { actual: { ...choice } },
    { catalog: null },
    {
      catalog: Array.from({ length: 513 }, (_, i) => ({
        ...model,
        id: `id-${i}`,
      })),
    },
    { catalog: [model, model] },
    { account: null },
  ])
    expect(() =>
      checkedCodexAdmission(
        receipt({ ...snapshot(), ...change }),
        scope,
        { action: "refresh" },
        null,
      ),
    ).toThrow();
});
