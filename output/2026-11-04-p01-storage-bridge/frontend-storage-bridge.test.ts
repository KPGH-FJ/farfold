import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isValidElement, type ReactNode } from "react";
import { expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  effects: [] as (() => unknown)[],
  listeners: new Map<string, (event: { payload: number }) => void>(),
  stateCursor: 0,
  refCursor: 0,
}));
// Same small hook/event harness as DraftStartup.test.tsx. The draft store and
// DraftStartup's save/exit code stay real; native exit calls are only recorded.
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
  useRef: (current: unknown) => (h.refs[h.refCursor++] ??= { current }),
  useState: (initial: unknown) => {
    const index = h.stateCursor++;
    if (index >= h.states.length) h.states.push(initial);
    return [
      h.states[index],
      (value: unknown) => {
        h.states[index] =
          typeof value === "function" ? value(h.states[index]) : value;
      },
    ];
  },
  useEffect: (effect: () => unknown) => h.effects.push(effect),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (
    name: string,
    callback: (event: { payload: number }) => void,
  ) => {
    h.listeners.set(name, callback);
    return () => h.listeners.delete(name);
  },
}));
vi.mock("../../src/runtime/setup_storage", () => ({
  setupStorage: { load: async () => {}, flush: async () => {} },
  useSetupStorage: () => ({ ready: true, error: null }),
  SETUP_STORAGE_STRINGS: {},
}));
vi.mock("../../src/runtime/conversation_read_state", () => ({
  conversationReadState: {
    flushPending: async () => {},
    snapshot: () => ({ error: null }),
  },
}));
vi.mock("../../src/runtime/sessions", () => ({
  threads: {
    pauseQueuesForExit: vi.fn(),
    getSnapshot: () => ({ threads: new Map() }),
  },
}));
vi.mock("../../src/runtime/authentication", () => ({
  hasActiveAuthentication: () => false,
}));
vi.mock("../../src/runtime/update_impact", () => ({
  updateConversationBlocker: () => null,
}));
vi.mock("../../src/runtime/file_copy_jobs", () => ({
  hasUnsettledFileCopies: () => false,
  useFileCopyJobs: () => [],
  fileCopyJobs: { getSnapshot: () => [] },
}));
vi.mock("../../src/runtime/conversation_archive_jobs", () => ({
  useConversationArchiveJobs: () => [],
  conversationArchiveJobs: { hasUnknownFinished: () => false },
}));
vi.mock("../../src/components/FileCopyJobsStatus", () => ({
  FileCopyJobsStatus: () => null,
}));
vi.mock("../../src/components/ConversationArchiveJobsStatus", () => ({
  ConversationArchiveJobsStatus: () => null,
}));
vi.mock("../../src/components/WorktreeManagementHost", () => ({
  WorktreeManagementHost: () => null,
}));
vi.mock("../../src/components/StorageRecovery", () => ({
  StorageRecovery: () => null,
}));
vi.mock("../../src/components/WorkspaceDialog", () => ({
  WorkspaceDialog: () => null,
}));

const run = promisify(execFile);
const output = fileURLToPath(new URL("./", import.meta.url));
const root = path.resolve(output, "../..");
const driverName =
  "meta_store::recovery_tests::explicit_frontend_storage_bridge";
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function nodes(node: ReactNode): ReactNode[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [node];
  return [node, ...nodes(node.props.children)];
}

it("blocks DraftStartup exit after a real SQLite read-only error, then explicitly retries and cold loads", async () => {
  const binding = JSON.parse(
    await fs.readFile(path.join(output, "driver-binding-exit.json"), "utf8"),
  );
  expect(binding.driverName).toBe(driverName);
  expect(binding.defaultIgnoredVerified).toBe(true);
  const binary = await fs.realpath(binding.executable);
  expect(
    binary.startsWith(path.join(root, "src-tauri/target/debug/deps/")),
  ).toBe(true);
  const temporaryParent = await fs.realpath(tmpdir());
  const directory = await fs.mkdtemp(
    path.join(temporaryParent, "farfold-p01-storage-bridge-"),
  );
  await fs.chmod(directory, 0o700);
  const reportDirectory = await fs.mkdtemp(path.join(output, "run-"));
  await fs.chmod(reportDirectory, 0o700);
  const token = randomBytes(24).toString("hex");
  await fs.writeFile(
    path.join(directory, "fixture.marker.json"),
    JSON.stringify({ kind: "farfold-p01-storage-bridge-v1", token }),
    { flag: "wx", mode: 0o600 },
  );
  const calls: Array<Record<string, unknown>> = [];
  let fault = false;
  let readOnlyReceipt: string | null = null;
  const saved = "saved fixture draft🙂\nsecond paragraph";
  const edited = "newer local input🙂\nretained after actual SQLite refusal";
  let success = false;
  let stopStartup: (() => void) | undefined;
  let exitBlocked = false;
  let exitLeaseReleased = false;
  let renderedReadOnlyError = false;

  const exchange = async (
    command: "settings_get" | "settings_set",
    value?: unknown,
  ) => {
    expect(digest(await fs.readFile(binary))).toBe(binding.executableSha256);
    const id = randomBytes(24).toString("hex");
    for (const name of ["request.json", "response.json"]) {
      const file = path.join(directory, name);
      const stat = await fs.lstat(file).catch(() => null);
      if (stat) {
        expect(
          stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
        ).toBe(true);
        await fs.unlink(file);
      }
    }
    const request = {
      id,
      token,
      command,
      key: "unsentWork.v1",
      read_only: command === "settings_set" && fault,
      ...(command === "settings_set" ? { value } : {}),
    };
    await fs.writeFile(
      path.join(directory, "request.json"),
      JSON.stringify(request),
      { flag: "wx", mode: 0o600 },
    );
    const invocation = [
      driverName,
      "--exact",
      "--ignored",
      "--nocapture",
      "--test-threads=1",
    ];
    let stdout = "",
      stderr = "";
    try {
      ({ stdout, stderr } = await run(binary, invocation, {
        cwd: directory,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      }));
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      await fs.writeFile(
        path.join(reportDirectory, `failed-${calls.length + 1}.stdout.log`),
        failure.stdout ?? "",
        { mode: 0o600 },
      );
      await fs.writeFile(
        path.join(reportDirectory, `failed-${calls.length + 1}.stderr.log`),
        failure.stderr ?? "",
        { mode: 0o600 },
      );
      throw error;
    }
    const prefix = String(calls.length + 1).padStart(2, "0");
    await fs.writeFile(
      path.join(reportDirectory, `${prefix}.stdout.log`),
      stdout,
      {
        mode: 0o600,
      },
    );
    await fs.writeFile(
      path.join(reportDirectory, `${prefix}.stderr.log`),
      stderr,
      {
        mode: 0o600,
      },
    );
    expect(stdout).toContain("test result: ok. 1 passed; 0 failed;");
    const response = JSON.parse(
      await fs.readFile(path.join(directory, "response.json"), "utf8"),
    );
    expect(response.id).toBe(id);
    calls.push({ request, response, naturalExitCode: 0 });
    await fs.writeFile(
      path.join(reportDirectory, `${prefix}.json`),
      JSON.stringify(calls.at(-1), null, 2) + "\n",
      { mode: 0o600 },
    );
    if (!response.ok) {
      expect(typeof response.error).toBe("string");
      readOnlyReceipt = response.error;
      throw response.error;
    }
    return response.value;
  };

  try {
    h.invoke.mockImplementation(async (command, input) => {
      if (command === "app_drafts_ready" || command === "app_exit_after_save")
        return;
      expect(input.key).toBe("unsentWork.v1");
      expect(["settings_get", "settings_set"]).toContain(command);
      return exchange(command, input.value);
    });
    const d = await import("../../src/runtime/drafts");
    const persistence = d.draftPersistence;
    await persistence.load();
    d.composerDrafts.update("new", () => ({ text: saved, attachments: [] }));
    await persistence.flush();
    const original = await exchange("settings_get");
    expect(original.composers.new.text).toBe(saved);

    fault = true;
    d.composerDrafts.update("new", () => ({ text: edited, attachments: [] }));
    await expect(persistence.flush()).rejects.toThrow(/只读/);
    expect(readOnlyReceipt).toMatch(/^FARFOLD_STORAGE:readOnly:/);
    expect(await exchange("settings_get")).toEqual(original);
    expect(d.composerDrafts.read("new").text).toBe(edited);
    expect(persistence.snapshot().error).toContain("只读");
    expect(persistence.isSaved(persistence.revision())).toBe(false);

    const { DraftStartup } = await import("../../src/components/DraftStartup");
    const { DRAFT_STRINGS } = await import("../../src/runtime/draft_storage");
    const render = () => {
      h.stateCursor = 0;
      h.refCursor = 0;
      return DraftStartup({ children: "controlled editable content" });
    };
    render();
    stopStartup = h.effects[0]() as () => void;
    await vi.waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith("app_drafts_ready"),
    );
    const exits = () =>
      h.invoke.mock.calls.filter(
        ([command]) => command === "app_exit_after_save",
      );
    h.listeners.get("app:save-before-exit")!({ payload: 74 });
    expect(persistence.snapshot().interactionLocked).toBe(true);
    await vi.waitFor(() =>
      expect(persistence.snapshot().interactionLocked).toBe(false),
    );
    expect(exits()).toHaveLength(0);
    exitBlocked = true;
    exitLeaseReleased = true;
    const alert = nodes(render()).find(
      (node) =>
        isValidElement<{ role?: string }>(node) && node.props.role === "alert",
    );
    expect(
      nodes(alert)
        .filter((node) => typeof node === "string")
        .join(""),
    ).toContain("只读");
    renderedReadOnlyError = true;
    expect(d.composerDrafts.read("new").text).toBe(edited);
    expect(await exchange("settings_get")).toEqual(original);

    const beforeRetry = calls.length;
    fault = false;
    await Promise.resolve();
    expect(calls).toHaveLength(beforeRetry);
    const retry = nodes(render()).find(
      (node) =>
        isValidElement<{ children?: ReactNode }>(node) &&
        node.type === "button" &&
        node.props.children === DRAFT_STRINGS.retry,
    );
    expect(isValidElement<{ onClick?: () => void }>(retry)).toBe(true);
    if (!isValidElement<{ onClick?: () => void }>(retry))
      throw new Error("actual retry button is missing");
    retry.props.onClick!();
    await vi.waitFor(() => expect(exits()).toHaveLength(1));
    expect(exits()[0]).toEqual(["app_exit_after_save", { token: 74 }]);
    expect(persistence.snapshot().error).toBeNull();
    expect(persistence.isSaved(persistence.revision())).toBe(true);
    const current = await exchange("settings_get");
    expect(current.composers.new.text).toBe(edited);
    stopStartup();
    stopStartup = undefined;
    expect(persistence.snapshot().interactionLocked).toBe(false);
    vi.resetModules();
    const cold = await import("../../src/runtime/drafts");
    await cold.draftPersistence.load();
    expect(cold.composerDrafts.read("new").text).toBe(edited);
    expect(
      h.invoke.mock.calls.every(([command]) =>
        [
          "settings_get",
          "settings_set",
          "app_drafts_ready",
          "app_exit_after_save",
        ].includes(command),
      ),
    ).toBe(true);
    success = true;
  } finally {
    stopStartup?.();
    expect(path.dirname(directory)).toBe(temporaryParent);
    expect((await fs.lstat(directory)).isSymbolicLink()).toBe(false);
    const marker = JSON.parse(
      await fs.readFile(path.join(directory, "fixture.marker.json"), "utf8"),
    );
    expect(marker.token).toBe(token);
    await fs.rm(directory, { recursive: true });
    await fs.writeFile(
      path.join(reportDirectory, "result.json"),
      JSON.stringify(
        {
          passed: success,
          driverName,
          executableSha256: binding.executableSha256,
          callCount: calls.length,
          readOnlyReceipt,
          fixtureRemoved: true,
          exitCoordinator: {
            exitBlocked,
            exitLeaseReleased,
            renderedReadOnlyError,
            requests: h.invoke.mock.calls.filter(
              ([command]) => command === "app_exit_after_save",
            ),
            nativeExitExecuted: false,
          },
          scope:
            "Real production MetaStore and DraftStartup through controlled hooks/events and a test transport replacement; no complete Tauri IPC, DOM/installed UI, native exit, physical disk-full or Agent proof.",
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    console.info(`P01_STORAGE_BRIDGE_RESULT ${reportDirectory}/result.json`);
  }
});
