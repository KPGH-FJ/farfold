import { beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

const h = vi.hoisted(() => ({
  scope: "",
  cursor: 0,
  slots: new Map<string, unknown[]>(),
  effects: new Map<string, { deps?: unknown[]; cleanup?: () => void }[]>(),
  pending: [] as (() => void)[],
  items: [] as unknown[],
  fetchModels: vi.fn(),
  save: vi.fn(),
  test: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => true),
  Channel: class {},
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const scope = h.scope,
      index = h.cursor++;
    const slots = h.slots.get(scope)!;
    if (!(index in slots))
      slots[index] = typeof initial === "function" ? initial() : initial;
    return [
      slots[index],
      (value: unknown) => {
        slots[index] =
          typeof value === "function" ? value(slots[index]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const slots = h.slots.get(h.scope)!,
      index = h.cursor++;
    if (!(index in slots)) slots[index] = { current: initial };
    return slots[index];
  },
  useId: () => `${h.scope}-${h.cursor++}`,
  useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {
    const index = h.cursor++,
      effects = h.effects.get(h.scope)!;
    const previous = effects[index];
    if (
      !previous ||
      !deps ||
      deps.some((item, i) => !Object.is(item, previous.deps?.[i]))
    ) {
      const next = { deps } as typeof previous;
      effects[index] = next;
      h.pending.push(() => {
        previous?.cleanup?.();
        next.cleanup = effect() || undefined;
      });
    }
  },
}));
vi.mock("../runtime/credentials", async (original) => ({
  ...(await original<typeof import("../runtime/credentials")>()),
  listCredentials: vi.fn(async () => h.items),
  fetchApiModels: h.fetchModels,
  saveCredential: h.save,
  testApi: h.test,
  deleteCredential: h.remove,
  getServiceCapabilities: vi.fn(async () => ({
    apiTypes: [],
    validatedApiTypes: [],
    selectionScope: "draft",
    unavailableReason: null,
  })),
}));
import { CredentialSettings } from "./CredentialSettings";
import { STRINGS } from "../runtime/strings";
import { invoke } from "@tauri-apps/api/core";
import { SETTINGS_REDESIGN as R } from "../runtime/settings_redesign_strings";
import { API_EDITOR_STRINGS as E } from "../runtime/api_editor_strings";
import { ACCOUNT_GUIDE_STRINGS as G } from "../runtime/account_guide_strings";
import { ACCESS_STRINGS as A } from "../runtime/access_strings";
import type { ApiResult, Credential } from "../runtime/credentials";

const S = STRINGS.credentials;
type Element = ReactElement<Record<string, unknown>>;
function elements(tree: ReactNode) {
  const result: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      result.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(tree);
  return result;
}
function render(scope: string, fn: () => ReactNode) {
  h.scope = scope;
  h.cursor = 0;
  if (!h.slots.has(scope)) h.slots.set(scope, []);
  if (!h.effects.has(scope)) h.effects.set(scope, []);
  return elements(fn());
}
function child(scope: string, element: Element) {
  return render(scope, () =>
    (element.type as (props: Record<string, unknown>) => ReactNode)(
      element.props,
    ),
  );
}
function byComponent(nodes: Element[], name: string) {
  return nodes.find(
    (node) => typeof node.type === "function" && node.type.name === name,
  )!;
}
function button(nodes: Element[], label: string) {
  return (
    nodes.find(
      (node) =>
        node.type === "button" &&
        elements(node.props.children as ReactNode).length === 0 &&
        node.props.children === label,
    ) ??
    nodes.find(
      (node) =>
        node.type === "button" &&
        Children.toArray(node.props.children as ReactNode).includes(label),
    )!
  );
}
const flush = () => {
  for (const effect of h.pending.splice(0)) effect();
};
function field(nodes: Element[], name: string) {
  const label = nodes.find(
    (node) =>
      node.type === "label" &&
      elements(node.props.children as ReactNode).some(
        (item) => item.type === "span" && item.props.children === name,
      ),
  )!;
  return elements(label.props.children as ReactNode).find(
    (node) => node.type === "input" || node.type === "select",
  )!;
}
const labelInput = (nodes: Element[]) => field(nodes, S.label);
const click = (node: Element, currentTarget: unknown = {}) =>
  (node.props.onClick as (event: unknown) => void)({ currentTarget });
const input = (node: Element, value: string) =>
  (node.props.onChange as (event: unknown) => void)({ target: { value } });
const rootView = (active = true) =>
  render("root", () => CredentialSettings({ cards: [], active }));
const editorView = () => child("editor", byComponent(rootView(), "Editor"));
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
function focusTarget() {
  return Object.assign(new HTMLElement(), {
    isConnected: true,
    focus: vi.fn(),
    closest: () => null,
    getClientRects: () => [{}],
  });
}
function mountDialog(
  scope: string,
  element: Element,
  openDialogs: Set<unknown>,
) {
  const tree = child(scope, element);
  const native = {
    showModal: () => openDialogs.add(native),
    close: () => openDialogs.delete(native),
    querySelector: () => null,
    contains: () => false,
  };
  (
    tree.find((node) => node.type === "dialog")!.props.ref as {
      current: unknown;
    }
  ).current = native;
  flush();
  return { tree, native };
}
const unmount = (scope: string) =>
  h.effects.get(scope)?.forEach((effect) => effect?.cleanup?.());
const saved: Credential = {
  id: "own-service-a",
  label: "Alpha service",
  provider: "Alpha provider",
  endpoint: "https://a.example.com/v1",
  apiType: "chat-completions",
  models: ["alpha-model"],
  revision: "r1",
  complete: true,
  deleting: false,
  grants: [],
};
async function openEditor(item: Credential | null = null) {
  h.items = item ? [item] : [];
  rootView();
  flush();
  await settle();
  click(button(rootView(), item ? S.edit : S.add));
  return editorView();
}
async function newReadyEditor() {
  await openEditor();
  input(field(editorView(), S.label), "Own draft");
  input(field(editorView(), S.endpoint), saved.endpoint);
  input(field(editorView(), S.secret), "test-only-a-key");
  input(
    editorView().find(
      (node) => node.props["aria-label"] === S.modelPlaceholder,
    )!,
    "alpha-model",
  );
  click(button(editorView(), S.addModel));
  expect(button(editorView(), S.save).props.disabled).toBe(false);
}
beforeEach(() => {
  h.slots.clear();
  h.effects.clear();
  h.pending = [];
  h.items = [];
  h.fetchModels.mockReset();
  h.save.mockReset();
  h.test.mockReset();
  h.remove.mockReset().mockResolvedValue(undefined);
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (command) =>
      command === "session_index_list" ? [] : true,
    );
  vi.stubGlobal("document", {
    activeElement: null,
    querySelectorAll: () => [],
  });
  vi.stubGlobal("HTMLElement", class {});
});

it.each([
  [S.endpoint, "https://b.example.com/v1", ""],
  [S.apiType, "messages", "chat-completions"],
])(
  "does not claim a previous key was invalidated when a new empty draft changes %s and back",
  async (name, changed, original) => {
    await openEditor();
    for (const value of [changed, original]) {
      input(field(editorView(), name), value);
      const editor = editorView();
      expect(
        editor.some((node) => node.props.children === S.changedSource),
      ).toBe(false);
      expect(field(editor, S.secret).props.value).toBe("");
      expect(field(editor, S.secret).props.placeholder).toBe(
        S.secretPlaceholder,
      );
      expect(button(editor, S.fetchModels).props.disabled).toBe(true);
      expect(button(editor, S.save).props.disabled).toBe(true);
      expect(byComponent(editor, "ApiTestPanel").props.disabled).toBe(true);
    }
    // Once all public fields are ready, the first key remains required.
    input(field(editorView(), S.label), "Own empty-key draft");
    input(field(editorView(), S.endpoint), saved.endpoint);
    input(
      editorView().find(
        (node) => node.props["aria-label"] === S.modelPlaceholder,
      )!,
      "alpha-model",
    );
    click(button(editorView(), S.addModel));
    const editor = editorView();
    expect(editor.some((node) => node.props.children === S.changedSource)).toBe(
      false,
    );
    expect(editor.some((node) => node.props.children === E.keyRequired)).toBe(
      true,
    );
    expect(button(editor, S.save).props.disabled).toBe(true);
    click(button(editor, S.fetchModels));
    click(button(editor, S.save));
    click(
      button(child("test", byComponent(editor, "ApiTestPanel")), S.startTest),
    );
    expect(h.fetchModels).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    expect(h.test).not.toHaveBeenCalled();
  },
);

it.each([
  ["endpoint", S.endpoint, "https://b.example.com/v1"],
  ["format", S.apiType, "messages"],
])(
  "requires a new key after changing an unsaved draft's %s",
  async (_, name, value) => {
    await newReadyEditor();
    input(field(editorView(), name), value);
    const editor = editorView();
    expect(field(editor, S.secret).props.value).toBe("");
    expect(editor.some((node) => node.props.children === S.changedSource)).toBe(
      true,
    );
    expect(button(editor, S.fetchModels).props.disabled).toBe(true);
    expect(button(editor, S.save).props.disabled).toBe(true);
    const test = byComponent(editor, "ApiTestPanel");
    expect(test.props.disabled).toBe(true);
    // Exercise both callers, not just their disabled appearance.
    click(button(editor, S.fetchModels));
    click(button(editor, S.save));
    click(button(child("test", test), S.startTest));
    expect(h.fetchModels).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    expect(h.test).not.toHaveBeenCalled();
    input(field(editorView(), S.secret), "test-only-b-key");
    expect(
      editorView().some((node) => node.props.children === S.changedSource),
    ).toBe(false);
    expect(button(editorView(), S.save).props.disabled).toBe(false);
    expect(byComponent(editorView(), "ApiTestPanel").props.disabled).toBe(
      false,
    );
  },
);

it.each([
  [S.endpoint, "https://b.example.com/v1", saved.endpoint, ""],
  [
    S.endpoint,
    "https://b.example.com/v1",
    saved.endpoint,
    "test-only-unsaved-key",
  ],
  [S.apiType, "messages", saved.apiType, ""],
  [S.apiType, "messages", saved.apiType, "test-only-unsaved-key"],
])(
  "does not restore a saved key after %s changes to %s and back to %s (draft key %j)",
  async (name, changed, originalValue, key) => {
    await openEditor(saved);
    const original = structuredClone(saved);
    if (key) input(field(editorView(), S.secret), key);
    expect(button(editorView(), S.fetchModels).props.disabled).toBe(false);
    input(field(editorView(), name), changed);
    input(field(editorView(), name), originalValue);
    const editor = editorView();
    expect(field(editor, S.secret).props.value).toBe("");
    expect(field(editor, S.secret).props.placeholder).toBe(S.secretPlaceholder);
    expect(editor.some((node) => node.props.children === S.changedSource)).toBe(
      true,
    );
    expect(button(editor, S.save).props.disabled).toBe(true);
    expect(button(editor, S.fetchModels).props.disabled).toBe(true);
    expect(byComponent(editor, "ApiTestPanel").props.disabled).toBe(true);
    expect(saved).toEqual(original);
    expect(h.save).not.toHaveBeenCalled();
  },
);

it("preserves an untouched legacy record but cannot bypass key re-entry after changing its source", async () => {
  await openEditor({ ...saved, complete: false, models: [] });
  input(field(editorView(), S.label), "Legacy renamed");
  expect(button(editorView(), S.save).props.disabled).toBe(false);
  input(field(editorView(), S.endpoint), "https://b.example.com/v1");
  input(field(editorView(), S.endpoint), saved.endpoint);
  expect(button(editorView(), S.save).props.disabled).toBe(true);
  click(button(editorView(), S.save));
  expect(h.save).not.toHaveBeenCalled();
});

it("retains a key for naming/model edits and unchanged normalized source", async () => {
  await newReadyEditor();
  input(field(editorView(), S.label), "Renamed");
  input(field(editorView(), S.provider), "Other provider description");
  input(field(editorView(), S.endpoint), ` ${saved.endpoint}/ `);
  input(field(editorView(), S.apiType), saved.apiType);
  click(
    editorView().find(
      (node) => node.props["aria-label"] === `${S.removeModel} alpha-model`,
    )!,
  );
  expect(field(editorView(), S.secret).props.value).toBe("test-only-a-key");
  expect(button(editorView(), S.fetchModels).props.disabled).toBe(false);
});

it("invalidates an in-flight model read and only sends a re-entered key on explicit retry", async () => {
  await newReadyEditor();
  let resolve!: (result: ApiResult) => void;
  h.fetchModels.mockImplementation(
    () =>
      new Promise<ApiResult>((done) => {
        resolve = done;
      }),
  );
  click(button(editorView(), S.fetchModels));
  const first = h.fetchModels.mock.calls[0][0];
  expect(first.source.input.key).toBe("test-only-a-key");
  input(field(editorView(), S.endpoint), "https://b.example.com/v1");
  resolve({
    requestId: first.requestId,
    status: "success",
    message: "OWN-STALE-SUCCESS",
    models: ["old-model"],
  });
  await settle();
  expect(
    editorView().some((node) => node.props.children === "OWN-STALE-SUCCESS"),
  ).toBe(false);
  expect(h.fetchModels).toHaveBeenCalledOnce();
  input(field(editorView(), S.secret), "test-only-b-key");
  expect(h.fetchModels).toHaveBeenCalledOnce();
  click(button(editorView(), S.fetchModels));
  expect(h.fetchModels).toHaveBeenCalledTimes(2);
  expect(h.fetchModels.mock.calls[1][0].source.input).toMatchObject({
    endpoint: "https://b.example.com/v1",
    key: "test-only-b-key",
    id: null,
  });
});

const searchLabel = "搜索 API 配置";
const searchInput = (nodes: Element[]) =>
  nodes.find(
    (node) => node.type === "input" && node.props["aria-label"] === searchLabel,
  )!;
const records = (nodes: Element[]) =>
  nodes.filter((node) => node.type === "article");
const loginKey: Credential = {
  ...saved,
  id: "own-login-key",
  label: "Own login key",
  provider: "openai",
  purpose: "authentication",
  endpoint: "",
  apiType: "",
  models: [],
  complete: false,
};
it("shows login keys as saved without service setup or service actions and preserves older records", async () => {
  const legacy: Credential = {
    ...saved,
    id: "legacy-key",
    label: "Legacy key",
    endpoint: "",
    apiType: "",
    models: [],
    complete: false,
  };
  h.items = [loginKey, saved, legacy];
  rootView();
  flush();
  await settle();
  const rows = records(rootView());
  const row = (id: string) => elements(rows.find((node) => node.key === id)!);
  const keyNodes = row(loginKey.id);
  expect(
    keyNodes.some(
      (node) =>
        node.props.children === `${loginKey.provider} · ${S.authenticationKey}`,
    ),
  ).toBe(true);
  expect(keyNodes.some((node) => node.props.children === S.saved)).toBe(true);
  expect(
    keyNodes.some((node) => node.props.children === S.authenticationKeyHint),
  ).toBe(true);
  expect(
    keyNodes.some(
      (node) =>
        node.props.className === "api-base-url" ||
        node.props.className === "api-model-tags" ||
        node.props.children === S.needsSetup ||
        node.props.children === S.incompleteHint,
    ),
  ).toBe(false);
  expect(button(keyNodes, S.edit)).toBeUndefined();
  expect(button(keyNodes, S.test)).toBeUndefined();
  expect(button(keyNodes, S.delete)).toBeDefined();
  expect(byComponent(keyNodes, "ApiTestPanel")).toBeUndefined();
  expect(byComponent(rootView(), "Editor")).toBeUndefined();
  expect(button(row(legacy.id), S.edit).props.disabled).toBe(false);
  expect(button(row(legacy.id), S.test).props.disabled).toBe(true);
  expect(
    row(legacy.id).some((node) => node.props.children === S.incompleteHint),
  ).toBe(true);
  const serviceNodes = row(saved.id);
  expect(
    serviceNodes.some((node) => node.props.children === saved.endpoint),
  ).toBe(true);
  expect(button(serviceNodes, S.test).props.disabled).toBe(false);
  click(button(serviceNodes, S.test));
  expect(byComponent(rootView(), "ApiTestPanel").props.source).toEqual({
    kind: "saved",
    id: saved.id,
  });
  click(button(row(legacy.id), S.edit));
  expect(byComponent(rootView(), "Editor").props.item).toBe(legacy);
  expect(h.fetchModels).not.toHaveBeenCalled();
  expect(h.test).not.toHaveBeenCalled();
  expect(h.save).not.toHaveBeenCalled();
});

it.each([false, true])(
  "keeps login-key deletion and cancellation available when cleanup is pending: %s",
  async (deleting) => {
    h.items = [{ ...loginKey, deleting }];
    rootView();
    flush();
    await settle();
    const removeLabel = deleting ? S.retry : S.delete;
    if (deleting)
      expect(
        rootView().some((node) => node.props.children === S.deletePending),
      ).toBe(true);
    click(button(rootView(), removeLabel));
    rootView();
    flush();
    await settle();
    let modal = byComponent(rootView(), "Dialog");
    expect(modal.props.title).toBe(S.confirmDeleteAuthenticationKey);
    let dialog = child("delete-dialog", modal);
    expect(
      dialog.some(
        (node) => node.props.children === S.deleteAuthenticationKeyHint,
      ),
    ).toBe(true);
    click(button(dialog, S.cancel));
    expect(h.remove).not.toHaveBeenCalled();
    click(button(rootView(), removeLabel));
    rootView();
    flush();
    await settle();
    modal = byComponent(rootView(), "Dialog");
    dialog = child("delete-dialog", modal);
    expect(button(dialog, S.delete).props.disabled).toBe(false);
    click(button(dialog, S.delete));
    await settle();
    expect(h.remove).toHaveBeenCalledExactlyOnceWith(loginKey.id);
    expect(records(rootView())).toHaveLength(0);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.fetchModels).not.toHaveBeenCalled();
    expect(h.test).not.toHaveBeenCalled();
  },
);

async function loadSearchItems() {
  h.items = [
    saved,
    {
      ...saved,
      id: "beta",
      label: "Beta service",
      provider: "OwnProvider",
      models: ["BetaModel"],
    },
    {
      ...saved,
      id: "gamma",
      label: "Gamma service",
      provider: "Gamma",
      models: ["GammaModel"],
    },
  ];
  rootView();
  flush();
  await settle();
}
it.each(["  bEtA SERVICE  ", " OWNprovider ", " betamodel "])(
  "filters saved configurations by label/provider/model with query %j",
  async (query) => {
    await loadSearchItems();
    input(searchInput(rootView()), query);
    const filtered = records(rootView());
    expect(filtered).toHaveLength(1);
    expect(
      elements(filtered[0]).some(
        (node) => node.type === "h3" && node.props.children === "Beta service",
      ),
    ).toBe(true);
    expect(h.fetchModels).not.toHaveBeenCalled();
    expect(h.test).not.toHaveBeenCalled();
  },
);
it("keeps the query and clear exit after deleting its only match from three records", async () => {
  await loadSearchItems();
  input(searchInput(rootView()), "BetaModel");
  click(button(rootView(), S.delete));
  rootView();
  flush();
  await settle();
  const dialog = child("delete-dialog", byComponent(rootView(), "Dialog"));
  click(button(dialog, S.delete));
  await settle();
  expect(h.remove).toHaveBeenCalledExactlyOnceWith("beta");
  expect(searchInput(rootView()).props.value).toBe("BetaModel");
  expect(records(rootView())).toHaveLength(0);
  click(button(rootView(), "清除搜索"));
  expect(records(rootView())).toHaveLength(2);
  expect(searchInput(rootView())).toBeUndefined();
});
it("keeps saved configuration search when temporarily hidden", async () => {
  await loadSearchItems();
  input(searchInput(rootView()), "GammaModel");
  expect(rootView(false)[0].props.hidden).toBe(true);
  expect(searchInput(rootView()).props.value).toBe("GammaModel");
  expect(records(rootView())).toHaveLength(1);
});

it("shows affected saved conversations, including archived ones, before deletion and keeps cancel non-destructive", async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "session_index_list"
      ? [
          {
            id: "old",
            title: "Original API work",
            archived: true,
            configOptions: {
              _farfoldService: {
                kind: "configured",
                identity: {
                  id: saved.id,
                  model: "old-model",
                  fingerprint: "old-revision",
                },
              },
            },
          },
          {
            id: "other",
            title: "Other source",
            configOptions: {
              _farfoldService: {
                kind: "configured",
                identity: { id: "other", model: saved.models[0] },
              },
            },
          },
        ]
      : true,
  );
  h.items = [saved];
  rootView();
  flush();
  await settle();
  click(button(rootView(), S.delete));
  rootView();
  flush();
  await settle();
  const dialog = child("delete-dialog", byComponent(rootView(), "Dialog"));
  expect(
    dialog.some((node) => node.props.children === "Original API work"),
  ).toBe(true);
  expect(dialog.some((node) => node.props.children === "Other source")).toBe(
    false,
  );
  click(button(dialog, S.cancel));
  expect(h.remove).not.toHaveBeenCalled();
});

it("does not treat a failed impact read as no affected conversations", async () => {
  vi.mocked(invoke).mockRejectedValue(Error("index unavailable"));
  h.items = [saved];
  rootView();
  flush();
  await settle();
  click(button(rootView(), S.delete));
  rootView();
  flush();
  await settle();
  const dialog = child("delete-dialog", byComponent(rootView(), "Dialog"));
  expect(button(dialog, S.delete).props.disabled).toBe(true);
  click(button(dialog, S.delete));
  expect(h.remove).not.toHaveBeenCalled();
});

it("hides all API editor dialogs and restores the same unsaved form without closing it", async () => {
  let root = render("root", () =>
    CredentialSettings({ cards: [], active: true }),
  );
  flush();
  await Promise.resolve();
  await Promise.resolve();
  root = render("root", () => CredentialSettings({ cards: [], active: true }));
  click(button(root, S.add));
  root = render("root", () => CredentialSettings({ cards: [], active: true }));
  let editor = child("editor", byComponent(root, "Editor"));
  (labelInput(editor).props.onChange as (event: unknown) => void)({
    target: { value: "OWN-UNSAVED-SERVICE" },
  });
  editor = child("editor", byComponent(root, "Editor"));
  const initialDialog = byComponent(editor, "Dialog");
  let dialog = child("dialog", initialDialog);
  const native = {
    showModal: vi.fn(),
    close: vi.fn(),
    querySelector: () => null,
  };
  (
    dialog.find((node) => node.type === "dialog")!.props.ref as {
      current: unknown;
    }
  ).current = native;
  flush();
  expect(native.showModal).toHaveBeenCalledOnce();

  root = render("root", () => CredentialSettings({ cards: [], active: false }));
  expect(root[0].props.hidden).toBe(true);
  editor = child("editor", byComponent(root, "Editor"));
  expect(byComponent(editor, "Dialog").props.active).toBe(false);
  dialog = child("dialog", byComponent(editor, "Dialog"));
  flush();
  expect(native.close).toHaveBeenCalled();
  expect(native.showModal).toHaveBeenCalledOnce();
  expect(labelInput(editor).props.value).toBe("OWN-UNSAVED-SERVICE");

  root = render("root", () => CredentialSettings({ cards: [], active: true }));
  editor = child("editor", byComponent(root, "Editor"));
  child("dialog", byComponent(editor, "Dialog"));
  flush();
  expect(native.showModal).toHaveBeenCalledTimes(2);
  expect(labelInput(editor).props.value).toBe("OWN-UNSAVED-SERVICE");
  expect(byComponent(root, "Editor").props.item).toBeNull();
});

it("shows endpoint errors beside the field and clears them as soon as they are corrected", async () => {
  await openEditor();
  let endpoint = field(editorView(), S.endpoint);
  expect(endpoint.props["aria-invalid"]).toBeUndefined();
  (endpoint.props.onBlur as () => void)();
  endpoint = field(editorView(), S.endpoint);
  expect(endpoint.props["aria-invalid"]).toBe(true);
  expect(
    editorView().some((node) => node.props.children === E.endpointRequired),
  ).toBe(true);

  input(endpoint, "https://models.example.com/v1/chat/completions");
  let editor = editorView();
  endpoint = field(editor, S.endpoint);
  const error = editor.find(
    (node) => node.props.className === "api-field-error",
  )!;
  expect(error.props.children).toBe(E.endpointPath);
  expect(endpoint.props["aria-describedby"]).toContain(error.props.id);
  expect(button(editor, S.fetchModels).props.disabled).toBe(true);
  expect(button(editor, S.save).props.disabled).toBe(true);

  input(endpoint, "https://models.example.com/v1");
  editor = editorView();
  expect(field(editor, S.endpoint).props["aria-invalid"]).toBeUndefined();
  expect(
    editor.some((node) => node.props.className === "api-field-error"),
  ).toBe(false);
});

it("keeps invalid-address actions blocked even when a new key and model are supplied", async () => {
  await newReadyEditor();
  input(field(editorView(), S.endpoint), "http://models.example.com/v1");
  input(field(editorView(), S.secret), "test-only-key");
  const editor = editorView();
  expect(button(editor, S.save).props.disabled).toBe(true);
  expect(button(editor, S.fetchModels).props.disabled).toBe(true);
  expect(byComponent(editor, "ApiTestPanel").props.disabled).toBe(true);
  click(button(editor, S.save));
  click(button(editor, S.fetchModels));
  expect(h.save).not.toHaveBeenCalled();
  expect(h.fetchModels).not.toHaveBeenCalled();
});

it("explains the save condition immediately and allows saving without any diagnostic", async () => {
  await newReadyEditor();
  const pending = () =>
    editorView().find(
      (node) => node.props["aria-label"] === S.modelPlaceholder,
    )!;
  input(pending(), "other-model");
  let editor = editorView();
  const feedback = editor.find(
    (node) => node.props.className === "api-save-feedback",
  )!;
  expect(
    elements(feedback).some((node) => node.props.children === E.pendingModel),
  ).toBe(true);
  expect(button(editor, S.save).props["aria-describedby"]).toBe(
    feedback.props.id,
  );
  expect(button(editor, S.save).props.disabled).toBe(true);
  click(button(editor, S.save));
  expect(h.save).not.toHaveBeenCalled();

  input(pending(), "");
  editor = editorView();
  expect(button(editor, S.save).props.disabled).toBe(false);
  expect(editor.some((node) => node.props.children === E.pendingModel)).toBe(
    false,
  );
  h.save.mockResolvedValue({ ...saved, label: "Own draft" });
  click(button(editor, S.save));
  await settle();
  expect(h.save).toHaveBeenCalledOnce();
  expect(h.fetchModels).not.toHaveBeenCalled();
  expect(h.test).not.toHaveBeenCalled();
});

it("cancels a model read explicitly and ignores its late result without saving or testing", async () => {
  await newReadyEditor();
  let resolve!: (result: ApiResult) => void;
  h.fetchModels.mockImplementation(
    () =>
      new Promise<ApiResult>((done) => {
        resolve = done;
      }),
  );
  click(button(editorView(), S.fetchModels));
  const request = h.fetchModels.mock.calls[0][0];
  click(button(editorView(), E.cancelRead));
  expect(button(editorView(), S.cancelling).props.disabled).toBe(true);
  await settle();
  expect(button(editorView(), S.fetchModels).props.disabled).toBe(false);
  resolve({
    requestId: request.requestId,
    status: "success",
    message: "LATE-READ",
    models: ["late-model"],
  });
  await settle();
  expect(editorView().some((node) => node.props.children === "LATE-READ")).toBe(
    false,
  );
  expect(
    editorView().some((node) => node.props.children === "late-model"),
  ).toBe(false);
  expect(h.save).not.toHaveBeenCalled();
  expect(h.test).not.toHaveBeenCalled();
});

it("keeps an unconfirmed model-read cancellation pending and offers another cancel attempt", async () => {
  await newReadyEditor();
  h.fetchModels.mockImplementation(() => new Promise<ApiResult>(() => {}));
  vi.mocked(invoke).mockResolvedValue(false);
  click(button(editorView(), S.fetchModels));
  click(button(editorView(), E.cancelRead));
  await settle();
  expect(
    editorView().some((node) => node.props.children === S.cancelFailed),
  ).toBe(true);
  expect(button(editorView(), E.cancelRead).props.disabled).toBe(false);
  expect(h.fetchModels).toHaveBeenCalledOnce();
  expect(h.save).not.toHaveBeenCalled();
});

it("opens the API account subpage and returns to the exact unsaved form without saving or sending its key", async () => {
  await newReadyEditor();
  click(button(editorView(), E.accountHelp));
  let guide = byComponent(editorView(), "ApiAccountGuide");
  expect(guide.props.stage).toBe("prepare");
  (guide.props.onProvider as (value: string) => void)("My service");
  guide = byComponent(editorView(), "ApiAccountGuide");
  (guide.props.onContinue as () => void)();
  guide = byComponent(editorView(), "ApiAccountGuide");
  expect(guide.props.stage).toBe("prepare");
  expect(guide.props.provider).toBe("My service");
  // Navigating away hides the current subpage while keeping the draft in memory.
  const hidden = child("editor", byComponent(rootView(false), "Editor"));
  expect(byComponent(hidden, "Dialog").props.active).toBe(false);
  rootView(true);
  (byComponent(editorView(), "ApiAccountGuide").props.onReturn as () => void)();
  expect(field(editorView(), S.label).props.value).toBe("Own draft");
  expect(field(editorView(), S.endpoint).props.value).toBe(saved.endpoint);
  expect(field(editorView(), S.secret).props.value).toBe("test-only-a-key");
  expect(field(editorView(), S.provider).props.value).toBe("My service");
  expect(button(editorView(), S.save).props.disabled).toBe(false);
  expect(h.save).not.toHaveBeenCalled();
  expect(h.test).not.toHaveBeenCalled();
  expect(h.fetchModels).not.toHaveBeenCalled();
});

it("keeps the API ownership explanation visible in an empty directory", async () => {
  rootView();
  flush();
  await settle();
  const nodes = rootView();
  expect(nodes.some((node) => node.props.children === G.apiEmpty)).toBe(true);
  expect(nodes.some((node) => node.props.children === G.apiBoundary)).toBe(
    true,
  );
  expect(nodes.some((node) => node.props.children === G.apiBoundaryHint)).toBe(
    true,
  );
});

it("cannot open or change the account guide during a pending save, including a stale click handler", async () => {
  await newReadyEditor();
  const priorHelp = button(editorView(), E.accountHelp);
  let reject!: (reason: Error) => void;
  h.save.mockReturnValue(
    new Promise((_resolve, fail) => {
      reject = fail;
    }),
  );
  click(button(editorView(), S.save));
  click(priorHelp);
  expect(byComponent(editorView(), "ApiAccountGuide")).toBeUndefined();
  const currentHelp = button(editorView(), E.accountHelp);
  expect(currentHelp.props.disabled).toBe(true);
  click(currentHelp);
  expect(byComponent(editorView(), "ApiAccountGuide")).toBeUndefined();
  expect(field(editorView(), S.provider).props.value).toBe("");
  expect(h.save).toHaveBeenCalledOnce();
  reject(Error("save failed"));
  await settle();
  expect(button(editorView(), E.accountHelp).props.disabled).toBe(false);
  expect(field(editorView(), S.secret).props.value).toBe("test-only-a-key");
  click(button(editorView(), E.accountHelp));
  expect(byComponent(editorView(), "ApiAccountGuide").props.stage).toBe(
    "prepare",
  );
});

it("returns to the actual add button after the nested discard dialog closes, even when native pointer focus was outside", async () => {
  await newReadyEditor();
  const opener = focusTarget(),
    cancel = focusTarget();
  click(button(rootView(), S.add), opener);
  const openDialogs = new Set<unknown>();
  vi.stubGlobal("document", {
    activeElement: null,
    querySelectorAll: () => [...openDialogs],
  });
  const mainElement = byComponent(editorView(), "Dialog");
  expect(
    (mainElement.props.returnFocusRef as { current: unknown }).current,
  ).toBe(opener);
  const main = mountDialog("main-focus", mainElement, openDialogs);
  (button(editorView(), S.cancel).props.ref as { current: unknown }).current =
    cancel;
  const stopPropagation = vi.fn();
  (
    main.tree.find((node) => node.type === "dialog")!.props.onCancel as (
      event: unknown,
    ) => void
  )({
    target: main.native,
    currentTarget: main.native,
    preventDefault: vi.fn(),
    stopPropagation,
  });
  expect(stopPropagation).toHaveBeenCalledOnce();
  const discard = editorView().find(
    (node) =>
      typeof node.type === "function" &&
      node.type.name === "Dialog" &&
      node.props.title === A.discardTitle,
  )!;
  expect((discard.props.returnFocusRef as { current: unknown }).current).toBe(
    cancel,
  );
  const dialog = mountDialog("discard-focus", discard, openDialogs);
  click(button(dialog.tree, A.discardChanges));
  expect(byComponent(rootView(), "Editor")).toBeUndefined();
  Object.assign(cancel, { isConnected: false });
  unmount("main-focus");
  unmount("discard-focus");
  await settle();
  expect(opener.focus).toHaveBeenCalledOnce();
  expect(cancel.focus).not.toHaveBeenCalled();
  expect(h.save).not.toHaveBeenCalled();
});

it.each(["edit", "delete"] as const)(
  "returns a cancelled %s dialog to its own row button",
  async (operation) => {
    await openEditor(saved);
    (byComponent(rootView(), "Editor").props.onClose as () => void)();
    const opener = focusTarget(),
      openDialogs = new Set<unknown>();
    vi.stubGlobal("document", {
      activeElement: null,
      querySelectorAll: () => [...openDialogs],
    });
    click(button(rootView(), operation === "edit" ? S.edit : S.delete), opener);
    rootView();
    flush();
    await settle();
    const element =
      operation === "edit"
        ? byComponent(editorView(), "Dialog")
        : byComponent(rootView(), "Dialog");
    expect((element.props.returnFocusRef as { current: unknown }).current).toBe(
      opener,
    );
    mountDialog("row-focus", element, openDialogs);
    (element.props.onClose as () => void)();
    unmount("row-focus");
    await settle();
    expect(opener.focus).toHaveBeenCalledOnce();
    expect(h.save).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
  },
);

it("compares actual service locations without retaining the prior key after a source edit", async () => {
  await openEditor(saved);
  input(field(editorView(), S.endpoint), "https://changed.example.test/v1");
  const nodes = editorView();
  const comparison = nodes.find(
    (node) => node.props["aria-label"] === R.sourceComparison,
  );
  expect(comparison).toBeDefined();
  const values = nodes
    .filter((node) => node.type === "dd")
    .map((node) => Children.toArray(node.props.children as ReactNode).join(""));
  expect(values.some((value) => value.includes(saved.endpoint))).toBe(true);
  expect(
    values.some((value) => value.includes("https://changed.example.test/v1")),
  ).toBe(true);
  expect(button(nodes, S.save).props.disabled).toBe(true);
  expect(field(nodes, S.secret).props.value).toBe("");
  expect(h.save).not.toHaveBeenCalled();
});
