import { beforeEach, expect, it, vi } from "vitest";
import {
  parsePromptTemplates,
  parseTemplateEdit,
} from "./prompt_template_data";

const mock = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke }));
const a = { id: "a", label: "检查", text: "检查当前改动" };
const b = { id: "b", label: "说明", text: "说明这段代码" };
const doc = (items: unknown[] = [a]) => ({ version: 1, items });
let persisted: unknown;
beforeEach(() => {
  vi.resetModules();
  mock.invoke.mockReset();
  persisted = doc();
  mock.invoke.mockImplementation(async (command, args) => {
    if (command === "settings_get")
      return args.key === "promptTemplates.v1"
        ? structuredClone(persisted)
        : null;
    if (command === "prompt_templates_save")
      persisted = structuredClone(args.next);
  });
});
const writes = () =>
  mock.invoke.mock.calls.filter(
    ([command, args]) => command === "prompt_templates_save",
  );
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

it("reads the complete strict document and preserves literal template text", () => {
  expect(parsePromptTemplates(doc())).toEqual(doc());
  expect(parsePromptTemplates(null)).toEqual(doc([]));
  const literal = { ...a, text: "  $skill\n{{path}}\n  " };
  expect(parsePromptTemplates(doc([literal])).items[0].text).toBe(literal.text);
});
it.each([
  { version: 2, items: [] },
  { version: 1, items: [], future: true },
  doc([{ ...a, extra: true }]),
  doc([a, a]),
  doc([{ ...a, id: "" }]),
  doc([{ ...a, label: " " }]),
  doc([{ ...a, label: "a".repeat(81) }]),
  doc([{ ...a, text: " " }]),
  doc([{ ...a, text: "a".repeat(32001) }]),
  doc(Array.from({ length: 101 }, (_, i) => ({ ...a, id: String(i) }))),
  doc(
    Array.from({ length: 20 }, (_, i) => ({
      ...a,
      id: String(i),
      text: "中".repeat(32000),
    })),
  ),
  undefined,
])(
  "rejects malformed, future and oversized documents without salvage: %#",
  (value) => {
    expect(() => parsePromptTemplates(value)).toThrow();
  },
);
it("allows an unfinished empty editor but validates the optional original", () => {
  const edit = { id: "new", label: "", text: "" };
  expect(parseTemplateEdit(edit)).toEqual(edit);
  expect(parseTemplateEdit(undefined)).toBeNull();
  expect(() => parseTemplateEdit({ ...edit, original: a })).toThrow();
  expect(() => parseTemplateEdit({ ...a, future: true })).toThrow();
});
it("loads without writing and saves through a confirmed readback", async () => {
  const { promptTemplates } = await import("./prompt_templates");
  await promptTemplates.load();
  expect(promptTemplates.snapshot()).toMatchObject({ ready: true, items: [a] });
  expect(writes()).toHaveLength(0);
  await promptTemplates.save(b);
  expect(promptTemplates.snapshot()).toMatchObject({
    items: [a, b],
    saving: false,
    uncertain: false,
  });
  expect(writes()).toHaveLength(1);
  expect(mock.invoke.mock.calls.at(-1)).toEqual([
    "settings_get",
    { key: "promptTemplates.v1" },
  ]);
});
it("never overwrites an unread future document", async () => {
  persisted = { version: 2, items: [] };
  const { promptTemplates } = await import("./prompt_templates");
  await expect(promptTemplates.load()).rejects.toThrow();
  await expect(promptTemplates.save(b)).rejects.toThrow();
  expect(writes()).toHaveLength(0);
  expect(promptTemplates.snapshot().ready).toBe(false);
});
it("serializes concurrent saves and rejects duplicate or stale expectations", async () => {
  const { promptTemplates } = await import("./prompt_templates");
  await Promise.all([
    promptTemplates.save(b),
    promptTemplates.save({ ...a, text: "new" }, a),
  ]);
  expect(persisted).toEqual(doc([{ ...a, text: "new" }, b]));
  await expect(promptTemplates.save(a)).rejects.toThrow();
  await expect(promptTemplates.remove(a)).rejects.toThrow();
  expect(writes()).toHaveLength(2);
});
it("reconciles a failed write when its exact intended document can be read", async () => {
  const defaultInvoke = mock.invoke.getMockImplementation()!;
  mock.invoke.mockImplementation(async (command, args) => {
    await defaultInvoke(command, args);
    if (command === "prompt_templates_save") throw new Error("lost reply");
    return command === "settings_get" && args.key === "promptTemplates.v1"
      ? structuredClone(persisted)
      : null;
  });
  const { promptTemplates } = await import("./prompt_templates");
  await promptTemplates.save(b);
  expect(promptTemplates.snapshot()).toMatchObject({
    items: [a, b],
    uncertain: false,
    error: null,
  });
});
it("keeps unknown writes blocked even when reload sees the previous value", async () => {
  const defaultInvoke = mock.invoke.getMockImplementation()!;
  mock.invoke.mockImplementation(async (command, args) => {
    if (command === "prompt_templates_save") throw new Error("unknown");
    return defaultInvoke(command, args);
  });
  const { promptTemplates } = await import("./prompt_templates");
  await expect(promptTemplates.save(b)).rejects.toThrow();
  await expect(promptTemplates.reload()).rejects.toThrow();
  await expect(promptTemplates.save({ ...b, text: "retry" })).rejects.toThrow();
  expect(writes()).toHaveLength(1);
  expect(promptTemplates.snapshot()).toMatchObject({
    items: [a],
    uncertain: true,
  });
  persisted = doc([a, b]);
  await promptTemplates.reload();
  expect(promptTemplates.snapshot()).toMatchObject({
    items: [a, b],
    uncertain: false,
  });
});
it("does not trust a success acknowledgement without matching readback", async () => {
  const defaultInvoke = mock.invoke.getMockImplementation()!;
  mock.invoke.mockImplementation((command, args) =>
    command === "prompt_templates_save"
      ? Promise.resolve()
      : defaultInvoke(command, args),
  );
  const { promptTemplates } = await import("./prompt_templates");
  await expect(promptTemplates.remove(a)).rejects.toThrow();
  expect(promptTemplates.snapshot().uncertain).toBe(true);
});
it("retains an edit changed during a save and leaves clearing to the exact editor owner", async () => {
  const { templateEditDrafts, draftPersistence } = await import("./drafts");
  await draftPersistence.load();
  templateEditDrafts.update({ ...a, original: a, text: "first" });
  await draftPersistence.flush();
  const captured = templateEditDrafts.read()!;
  const gate = deferred<void>();
  const entered = deferred<void>();
  const defaultInvoke = mock.invoke.getMockImplementation()!;
  mock.invoke.mockImplementation(async (command, args) => {
    if (command === "prompt_templates_save") {
      entered.resolve();
      await gate.promise;
    }
    return defaultInvoke(command, args);
  });
  const { promptTemplates } = await import("./prompt_templates");
  const saving = promptTemplates.save(
    { id: captured.id, label: captured.label, text: captured.text },
    a,
  );
  await entered.promise;
  templateEditDrafts.update({ ...captured, text: "second" });
  gate.resolve();
  await saving;
  expect(templateEditDrafts.read()?.text).toBe("second");
  expect(templateEditDrafts.read()).not.toBe(captured);
});

it("passes the complete baseline to CAS and rejects a competing update without retrying", async () => {
  const defaultInvoke = mock.invoke.getMockImplementation()!;
  mock.invoke.mockImplementation(async (command, args) => {
    if (command === "prompt_templates_save") {
      expect(args.expected).toEqual(doc());
      persisted = doc([{ ...a, text: "other writer" }]);
      return { status: "conflict" };
    }
    return defaultInvoke(command, args);
  });
  const { promptTemplates } = await import("./prompt_templates");
  await expect(promptTemplates.save(b)).rejects.toThrow();
  expect(writes()).toHaveLength(1);
  expect(promptTemplates.snapshot()).toMatchObject({
    items: [{ ...a, text: "other writer" }],
    uncertain: false,
  });
});

it("normalizes expected fields regardless of object key ordering", async () => {
  const { promptTemplates } = await import("./prompt_templates");
  await promptTemplates.save(
    { ...a, text: "new" },
    { text: a.text, label: a.label, id: a.id },
  );
  expect(persisted).toEqual(doc([{ ...a, text: "new" }]));
});
it("unlocks a confirmed rolled-back rejection after readback so a repaired store can retry", async () => {
  const defaultInvoke = mock.invoke.getMockImplementation()!;
  let full = true;
  mock.invoke.mockImplementation((command, args) =>
    command === "prompt_templates_save" && full
      ? Promise.resolve({
          status: "rejected",
          message: "FARFOLD_STORAGE:full:saving",
        })
      : defaultInvoke(command, args),
  );
  const { promptTemplates } = await import("./prompt_templates");
  await expect(promptTemplates.save(b)).rejects.toThrow();
  expect(promptTemplates.snapshot().uncertain).toBe(false);
  full = false;
  await promptTemplates.save(b);
  expect(persisted).toEqual(doc([a, b]));
});
it.each(["before", "after"])(
  "explicit read-only recovery preserves edits and a late old CAS %s the next CAS cannot overwrite a later confirmed save",
  async (when) => {
    const { templateEditDrafts, draftPersistence } = await import("./drafts");
    await draftPersistence.load();
    templateEditDrafts.update(b);
    await draftPersistence.flush();
    const captured = templateEditDrafts.read();
    const defaultInvoke = mock.invoke.getMockImplementation()!;
    let old: { expected: unknown; next: unknown } | null = null;
    let first = true;
    const applyOld = () => {
      if (old && JSON.stringify(persisted) === JSON.stringify(old.expected))
        persisted = structuredClone(old.next);
    };
    mock.invoke.mockImplementation(async (command, args) => {
      if (command !== "prompt_templates_save")
        return defaultInvoke(command, args);
      if (first) {
        first = false;
        old = structuredClone(args);
        throw new Error("lost IPC");
      }
      if (when === "before") applyOld();
      if (JSON.stringify(persisted) !== JSON.stringify(args.expected))
        return { status: "conflict" };
      persisted = structuredClone(args.next);
      return { status: "saved" };
    });
    const { promptTemplates } = await import("./prompt_templates");
    await expect(promptTemplates.save(b)).rejects.toThrow();
    await promptTemplates.recoverUnknown();
    expect(promptTemplates.snapshot()).toMatchObject({
      uncertain: false,
      error: null,
    });
    expect(promptTemplates.snapshot().notice).toBeTruthy();
    expect(writes()).toHaveLength(1);
    expect(templateEditDrafts.read()).toBe(captured);
    const next = { ...b, text: "later choice" };
    if (when === "before") {
      await expect(promptTemplates.save(next)).rejects.toThrow();
      expect(persisted).toEqual(doc([a, b]));
    } else {
      await promptTemplates.save(next);
      applyOld();
      expect(persisted).toEqual(doc([a, next]));
    }
    expect(templateEditDrafts.read()).toBe(captured);
  },
);
it("retains unknown input when readback fails and preserves immutable stable snapshots", async () => {
  let wrote = false;
  const defaultInvoke = mock.invoke.getMockImplementation()!;
  mock.invoke.mockImplementation(async (command, args) => {
    if (command === "prompt_templates_save") {
      wrote = true;
      return "saved";
    }
    if (
      wrote &&
      command === "settings_get" &&
      args.key === "promptTemplates.v1"
    )
      throw new Error("not readable");
    return defaultInvoke(command, args);
  });
  const { promptTemplates } = await import("./prompt_templates");
  await promptTemplates.load();
  const snapshot = promptTemplates.snapshot();
  expect(promptTemplates.snapshot()).toBe(snapshot);
  expect(() => {
    snapshot.items[0].text = "mutate";
  }).toThrow();
  await expect(promptTemplates.save(b)).rejects.toThrow();
  await expect(promptTemplates.remove(a)).rejects.toThrow();
  expect(writes()).toHaveLength(1);
  expect(promptTemplates.snapshot()).toMatchObject({
    items: [a],
    uncertain: true,
  });
});
it("does not confirm deletion when the entire setting disappears instead of matching the intended document", async () => {
  const defaultInvoke = mock.invoke.getMockImplementation()!;
  mock.invoke.mockImplementation((command, args) => {
    if (command === "prompt_templates_save") {
      persisted = null;
      return Promise.resolve("saved");
    }
    return defaultInvoke(command, args);
  });
  const { promptTemplates } = await import("./prompt_templates");
  await expect(promptTemplates.remove(a)).rejects.toThrow();
  expect(promptTemplates.snapshot().uncertain).toBe(true);
});

it("cannot release unknown protection by reading an unsupported document", async () => {
  const defaultInvoke = mock.invoke.getMockImplementation()!;
  mock.invoke.mockImplementation((command, args) =>
    command === "prompt_templates_save"
      ? Promise.reject(new Error("unknown"))
      : defaultInvoke(command, args),
  );
  const { promptTemplates } = await import("./prompt_templates");
  await expect(promptTemplates.save(b)).rejects.toThrow();
  persisted = { version: 2, items: [] };
  await expect(promptTemplates.recoverUnknown()).rejects.toThrow();
  await expect(promptTemplates.save(b)).rejects.toThrow();
  expect(promptTemplates.snapshot().uncertain).toBe(true);
  expect(writes()).toHaveLength(1);
});

it("keeps classified read failures accurate and never dispatches a write", async () => {
  const defaultInvoke = mock.invoke.getMockImplementation()!;
  mock.invoke.mockImplementation((command, args) =>
    command === "settings_get" && args.key === "promptTemplates.v1"
      ? Promise.reject("FARFOLD_STORAGE:permission:read")
      : defaultInvoke(command, args),
  );
  const { promptTemplates } = await import("./prompt_templates");
  const { STRINGS } = await import("./strings");
  await expect(promptTemplates.save(b)).rejects.toThrow(
    STRINGS.storageRecovery.issues.permission,
  );
  expect(promptTemplates.snapshot()).toMatchObject({
    ready: false,
    uncertain: false,
    error: STRINGS.storageRecovery.issues.permission,
  });
  expect(writes()).toHaveLength(0);
});
