import test from "node:test";
import assert from "node:assert/strict";
import {
  makePrototypeSnapshot,
  restorePrototypeSnapshot,
  readPrototypeState,
  writePrototypeState,
} from "../src/prototype-persistence.js";
import { applyArchivePolicy } from "../src/history-policy.js";
const draft = {
  text: "保留我的草稿",
  files: ["notes.md"],
  folder: "~/Notes",
  choice: {
    agent: "Codex",
    model: "6 Astra",
    effort: "High",
    source: "已有设置",
  },
};
const base = () => ({
  tasks: [],
  groups: ["我的分组"],
  draft: structuredClone(draft),
  archiveDays: "30",
  filters: { agent: "Codex", query: "草稿" },
});
test("L13: restart keeps draft and exact selection, attachment records require review", () => {
  const state = restorePrototypeSnapshot(makePrototypeSnapshot(base()));
  assert.deepEqual(state.draft, draft);
  assert.equal(state.attachmentsNeedReview, true);
  assert.equal(state.filters.query, "草稿");
});
test("L13: unfinished work becomes unknown; queue is preserved and paused", () => {
  const input = base();
  input.tasks = [
    {
      id: "r",
      status: "running",
      draft: "继续",
      queue: [{ text: "随后" }],
      simulatePending: true,
    },
    { id: "a", status: "approval", approvals: [{ id: "permission" }] },
  ];
  const state = restorePrototypeSnapshot(makePrototypeSnapshot(input));
  assert.equal(state.tasks[0].status, "unknown");
  assert.equal(state.tasks[0].simulatePending, false);
  assert.equal(state.tasks[0].queuePaused, true);
  assert.deepEqual(state.tasks[0].queue, input.tasks[0].queue);
  assert.deepEqual(state.tasks[1].approvals, input.tasks[1].approvals);
});
test("L13: interruption during first admission retains exactly one unknown request and new edits", () => {
  const input = base();
  input.pendingSend = { id: "ticket", draft: structuredClone(draft) };
  let state = restorePrototypeSnapshot(makePrototypeSnapshot(input));
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].prompt, draft.text);
  assert.equal(state.draft.text, "");
  assert.equal(state.active, "ticket");
  input.draft.text = "新增内容";
  state = restorePrototypeSnapshot(makePrototypeSnapshot(input));
  assert.equal(state.draft.text, "新增内容");
  assert.equal(
    restorePrototypeSnapshot(makePrototypeSnapshot(state)).tasks.length,
    1,
  );
});
test("L15: archive decisions and restore grace survive a round trip", () => {
  const now = Date.now(),
    input = base();
  input.tasks = [
    { id: "done", status: "done", lastActivityAt: now - 45 * 86400000 },
  ];
  input.tasks = applyArchivePolicy(input.tasks, "30", now).tasks;
  const state = restorePrototypeSnapshot(makePrototypeSnapshot(input));
  assert.equal(state.tasks[0].archived, true);
  assert.equal(state.tasks[0].archiveSource, "automatic");
  assert.equal(state.archiveDays, "30");
});
test("prototype persistence never saves credential-shaped fields", () => {
  const input = base();
  input.services = [
    {
      id: "demo",
      apiKey: "must-not-save",
      secret: "must-not-save",
      secretRevision: 2,
      models: ["M"],
    },
  ];
  input.draft.choice.env = { TOKEN: "must-not-save" };
  const text = JSON.stringify(makePrototypeSnapshot(input));
  assert.ok(!text.includes("must-not-save"));
  assert.ok(text.includes("secretRevision"));
});
test("storage failure and obsolete snapshots do not pretend a successful save", () => {
  const storage = {
    getItem() {
      return "broken";
    },
    setItem() {
      throw new Error("full");
    },
  };
  assert.equal(readPrototypeState(storage), null);
  assert.equal(writePrototypeState(storage, base()), false);
  assert.equal(restorePrototypeSnapshot({ version: 5 }), null);
});
test("restart preserves work restrictions, pending auth and submitting requests conservatively", () => {
  const input = base();
  input.workPolicies = { "~/Notes": false };
  input.authBlocks = { source: { previousTestId: "x" } };
  input.agents = [
    {
      id: "a",
      accessJob: {
        id: "auth1",
        type: "auth",
        status: "waiting",
        selection: { folder: "~/Notes" },
      },
    },
  ];
  input.tasks = [{ id: "submitting", status: "submitting", queue: [] }];
  const state = restorePrototypeSnapshot(makePrototypeSnapshot(input));
  assert.equal(state.workPolicies["~/Notes"], false);
  assert.deepEqual(state.authBlocks, input.authBlocks);
  assert.equal(state.agents[0].accessJob.status, "unknown");
  assert.equal(state.agents[0].accessJob.id, "auth1");
  assert.equal(state.tasks[0].status, "unknown");
});
test("L13: conversation and queue attachment records require independent review", () => {
  const input = base();
  input.draft.files = [];
  input.tasks = [
    {
      id: "t",
      status: "done",
      attachments: ["lost.md"],
      queue: [{ id: "q", text: "保留正文", attachments: ["second.md"] }],
    },
  ];
  const state = restorePrototypeSnapshot(makePrototypeSnapshot(input));
  assert.equal(state.attachmentsNeedReview, false);
  assert.equal(state.tasks[0].attachmentsNeedReview, true);
  assert.equal(state.tasks[0].queue[0].text, "保留正文");
  assert.equal(state.tasks[0].queuePaused, true);
});
test("L15: failed storage never publishes new archive decisions or preferences", async () => {
  const { saveArchiveDecision } =
    await import("../src/prototype-persistence.js");
  const input = base();
  const proposed = { tasks: [{ id: "x", archived: true }], count: 1 };
  const failed = saveArchiveDecision(
    {
      setItem() {
        throw new Error("quota");
      },
    },
    input,
    proposed,
    "7",
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.state, input);
  assert.equal(failed.state.archiveDays, "30");
  assert.equal(failed.count, 0);
  const saved = saveArchiveDecision({ setItem() {} }, input, proposed, "7");
  assert.equal(saved.ok, true);
  assert.equal(saved.state.archiveDays, "7");
  assert.equal(saved.count, 1);
});
