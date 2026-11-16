import assert from "node:assert/strict";

export const taskReferencePath = "docs/agent-access-requirements.md";
export const taskStatusPath = "docs/status.md";
export const referenceRole =
  "<!-- role: task-requirements-reference; scheduling-authority: none -->";

const taskRow = /^\|\s*(ARCH-\d+|NEW-\d+|P\d+|H\d+)\s*\|/;
const packageIds = "ABCDEFGHIJKLMNXZ";
const commonPrefixes = ["每个条目的完成依据 =", "每次更新条目必须记录"];

export function parseTaskReference(text) {
  text = text.replace(/\r\n/g, "\n");
  assert.ok(
    text.includes(referenceRole),
    "requirements reference role missing",
  );
  const tasks = new Map();
  const packages = new Map();
  const common = [];
  let owner = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^#{2,6}\s+([A-NXZ])(?:\s|[.:：])/.exec(line);
    if (heading) owner = heading[1];
    else if (/^#{1,2}\s/.test(line)) owner = null;
    if (commonPrefixes.some((prefix) => line.startsWith(prefix)))
      common.push(line);
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (taskRow.test(line)) {
      assert.ok([3, 4].includes(cells.length), "unexpected task row shape");
      const [id, title] = cells;
      assert.ok(!tasks.has(id), `duplicate task ID: ${id}`);
      tasks.set(id, {
        id,
        title,
        progress: cells.length === 4 ? cells[2] : null,
        completion: cells.at(-1),
        package: id.startsWith("NEW-") ? null : owner,
      });
    } else if (cells.length === 3 && /^[A-NXZ]$/.test(cells[0])) {
      assert.ok(!packages.has(cells[0]), `duplicate package: ${cells[0]}`);
      packages.set(cells[0], { title: cells[1], completion: cells[2] });
    }
  }
  assert.equal(common.length, commonPrefixes.length, "common rules missing");
  assert.equal(packages.size, packageIds.length, "expected 16 work packages");
  for (const id of packageIds)
    assert.ok(packages.has(id), `missing work package: ${id}`);
  for (const task of tasks.values())
    if (!task.id.startsWith("NEW-"))
      assert.ok(packages.has(task.package), `missing package for ${task.id}`);
  const scope = text
    .split("## 官方接口与范围约束\n")[1]
    ?.split(/\n## /)[0]
    .trim();
  assert.ok(scope, "official interface and scope constraints missing");
  return { tasks, packages, common, scope };
}

export function selectTaskRequirements(reference, ids, extraPackages = []) {
  assert.ok(ids.length > 0, "请至少指定一个任务ID；不会默认输出全量明细。");
  const selected = [...new Set(ids)].map((id) => {
    const task = reference.tasks.get(id);
    assert.ok(task, `未知任务ID：${id}；请核对原始ID。`);
    return task;
  });
  assert.ok(
    !selected.some((task) => task.package === null) || extraPackages.length > 0,
    "NEW条目未注明所属包；请用 --package 显式指定相关包，例如 B,C,K。",
  );
  const neededPackages = new Set(
    selected.map((task) => task.package).filter(Boolean),
  );
  for (const id of extraPackages) {
    assert.ok(reference.packages.has(id), `未知工作包：${id}`);
    neededPackages.add(id);
  }
  // Read dependencies from the reference, rather than maintaining another map.
  // K currently declares itself universal; do not silently omit that condition.
  for (const [id, item] of reference.packages)
    if (item.completion.startsWith("贯穿所有包")) neededPackages.add(id);
  for (const id of neededPackages) {
    const clause = reference.packages.get(id).completion.split("；")[0];
    if (!clause.includes("依赖")) continue;
    for (const match of clause.matchAll(
      /(?<![A-Za-z0-9])([A-NXZ])(?![A-Za-z0-9])/g,
    ))
      neededPackages.add(match[1]);
  }
  return {
    tasks: selected,
    common: reference.common,
    scope: reference.scope,
    packages: [...neededPackages].map((id) => ({
      id,
      ...reference.packages.get(id),
    })),
  };
}

/** Current conclusions live once in status.md. Unmigrated rows remain explicitly
 * identified as reference progress, rather than being silently promoted. */
export function resolveTaskProgress(reference, statusText) {
  const current = new Map();
  const text = statusText.replace(/\r\n/g, "\n");
  const starts = [...text.matchAll(/<!-- task-current: ([A-Z0-9-]+) -->/g)];
  const blocks = [
    ...text.matchAll(
      /<!-- task-current: ([A-Z0-9-]+) -->\n+### ([A-Z0-9-]+)\n\n([\s\S]*?)\n<!-- \/task-current -->/g,
    ),
  ];
  assert.equal(blocks.length, starts.length, "malformed current task block");
  for (const [, id, heading, body] of blocks) {
    assert.equal(id, heading, `current task heading mismatch: ${id}`);
    assert.ok(reference.tasks.has(id), `unknown current task: ${id}`);
    assert.ok(!current.has(id), `duplicate current task: ${id}`);
    assert.ok(
      body.trim() && !body.includes("<!-- task-current:"),
      `empty or nested current task: ${id}`,
    );
    current.set(id, body.trim());
  }
  const tasks = new Map();
  for (const [id, task] of reference.tasks) {
    const pointer = `[最新结论](status.md#${id.toLowerCase()})`;
    const linked = task.progress === pointer;
    assert.ok(
      !current.has(id) || linked,
      `current task still duplicates reference progress: ${id}`,
    );
    assert.ok(
      !linked || current.has(id),
      `current task conclusion missing: ${id}`,
    );
    assert.ok(
      !task.progress?.includes("[最新结论](") || linked,
      `invalid current task link: ${id}`,
    );
    tasks.set(id, {
      ...task,
      progress: linked ? current.get(id) : task.progress,
      progressSource: linked
        ? `${taskStatusPath}#${id.toLowerCase()}`
        : taskReferencePath,
      currentConclusion: linked,
    });
  }
  return { ...reference, tasks };
}

export function renderTaskRequirements(selection) {
  const lines = [
    "# 按ID读取的要求（只读参考，无调度权）",
    "",
    "执行顺序只见 plans/agent-access.md；当前证据见 docs/status.md。首发名单与八项标准见 PRODUCT.md；本输出不改变范围或证明完成。",
    "",
    "已归并条目的最新结论直接读取 docs/status.md；要求参考只保留链接。其他条目明确标作参考进度，仍需核对原件。所有相对证据链接以 docs/ 为起点。",
    "",
    ...selection.common.flatMap((line) => [line, ""]),
    "## 官方接口与范围约束",
    "",
    selection.scope,
    "",
  ];
  for (const task of selection.tasks) {
    lines.push(`## ${task.id} ${task.title}`, "");
    if (task.progress !== null) {
      lines.push(
        `${task.currentConclusion ? "最新结论" : "参考进度（尚未归并）"}：${task.progress}`,
        "",
      );
      lines.push(`结论来源：${task.progressSource ?? taskReferencePath}`, "");
    }
    lines.push(`专项完成条件：${task.completion}`, "");
    if (task.package) lines.push(`所属工作包：${task.package}`, "");
    else
      lines.push(
        "原始NEW条目未注明所属包；以下工作包由本次 --package 明确指定，再补其依赖与普遍条件。本工具不猜测归属。",
        "",
      );
  }
  for (const item of selection.packages)
    lines.push(`## 工作包 ${item.id}：${item.title}`, "", item.completion, "");
  lines.push(`完整原文：${taskReferencePath}`, "");
  return lines.join("\n");
}
