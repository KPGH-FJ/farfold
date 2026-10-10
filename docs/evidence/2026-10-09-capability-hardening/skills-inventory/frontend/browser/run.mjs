import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const { webkit, chromium } =
  await import("/Users/tw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const base = "output/2026-10-10-skills-inventory-browser",
  engine = process.argv[2] ?? "webkit",
  label = process.argv[3] ?? "first";
const owned = JSON.parse(
  fs.readFileSync(
    "docs/evidence/2026-10-09-capability-hardening/skills-inventory/frontend/inputs-before.json",
  ),
).sourceRefs.map((x) => x.path);
const inputs = [
  ...owned,
  "src/runtime/extension_inventory.skills.test.ts",
  "src/components/AgentExtensionInventoryResult.tsx",
  "src/components/AgentExtensionInventoryResult.test.tsx",
  ...["fixture.tsx", "index.html", "serve.mjs", "run.mjs"].map(
    (n) => base + "/" + n,
  ),
];
const hashes = () =>
  Object.fromEntries(
    inputs.map((p) => [
      p,
      createHash("sha256").update(fs.readFileSync(p)).digest("hex"),
    ]),
  );
const r = {
  engine,
  label,
  before: hashes(),
  checks: [],
  errors: [],
  scope:
    "Actual App/AgentHub/AgentDetails/React StrictMode/registry owner and strict IPC parser/controller. Native boundary is controlled, no CLI/App/real configuration.",
};
const b = await (engine === "webkit" ? webkit : chromium).launch({
  headless: true,
  executablePath:
    engine === "webkit"
      ? path.resolve(
          "output/2026-10-10-text-feedback-webkit/browsers/webkit-2336/pw_run.sh",
        )
      : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const p = await b.newPage({ viewport: { width: 1100, height: 800 } });
p.setDefaultTimeout(7000);
p.on("pageerror", (e) => r.errors.push(String(e)));
const check = (name, pass, details) => {
  r.checks.push({ name, pass, ...(details === undefined ? {} : { details }) });
  if (!pass) throw Error(name);
};
const state = () => p.evaluate(() => window.fixture.current());
const count = async (cmd) =>
  (await state()).calls.filter((c) => c.cmd === cmd).length;
const dialog = () => p.locator("dialog.agent-detail-dialog[open]");
const section = () =>
  dialog().getByRole("region", { name: "技能与工具", exact: true });
const button = (name) => dialog().getByRole("button", { name, exact: true });
async function openDetails(id = "A") {
  await p
    .getByRole("button", { name: `查看详情 · Controlled ${id}`, exact: true })
    .click();
  await dialog().waitFor();
  await button("选择工作文件夹").waitFor();
}
async function choose(cwd = "/controlled/project-A") {
  await button("选择工作文件夹").click();
  await p.evaluate((path) => window.fixture.choose(path), cwd);
  await dialog().getByText(cwd, { exact: true }).first().waitFor();
}
async function read() {
  const n = (await state()).queries.length;
  await button(
    (await dialog()
      .getByRole("button", { name: "重新查询配置", exact: true })
      .count())
      ? "重新查询配置"
      : "检查 MCP 配置",
  ).click();
  await p.waitForFunction(
    (n) => window.fixture.current().queries.length === n + 1,
    n,
  );
  return (await state()).queries.at(-1).requestId;
}
async function close() {
  await dialog()
    .getByRole("button", { name: "关闭", exact: true })
    .first()
    .click();
  await dialog().waitFor({ state: "hidden" });
}
try {
  await p.route("**/*", (route) =>
    route.request().url().startsWith("http://127.0.0.1:1490/")
      ? route.continue()
      : route.abort(),
  );
  await p.goto("http://127.0.0.1:1490/" + base + "/index.html");
  await p
    .getByRole("button", { name: "探索 Agent", exact: true })
    .first()
    .click();
  await openDetails();
  const baseline = await state();
  check(
    "opening details only reads capability, no inventory query",
    baseline.queries.length === 0,
  );
  check(
    "StrictMode initial details invoke capability once",
    baseline.calls.filter((c) => c.cmd === "agent_extension_capabilities")
      .length === 1,
  );
  await choose();
  check(
    "choosing cwd does not query or change original draft cwd",
    (await state()).queries.length === 0 &&
      (await state()).cwd === baseline.cwd,
  );
  const first = await read();
  const call = (await state()).calls.find(
    (c) => c.cmd === "agent_extension_inventory_read",
  );
  check(
    "explicit query sends real capability ticket and exact selected scope",
    !!call.args.selectionId && call.args.cwd === "/controlled/project-A",
  );
  await p.evaluate((id) => window.fixture.finish(id, "Ordinary", 3), first);
  await dialog().getByText("Ordinary 0", { exact: true }).waitFor();
  check(
    "report separates config/auth from connection/tool/session claims",
    (await dialog().innerText()).includes("配置报告：已启用") &&
      (await dialog().innerText()).includes("认证报告：未登录") &&
      (await dialog().innerText()).includes("名称未显示"),
  );
  await dialog().getByText("范围与未验证事项", { exact: true }).click();
  check(
    "scope and capability limits explicit",
    (await dialog().innerText()).includes("当前对话是否生效") &&
      (await dialog().innerText()).includes("具体工具清单尚未提供"),
  );
  const second = await read();
  await p.evaluate((id) => window.fixture.fail(id), second);
  await dialog()
    .getByText("本次查询失败，未得到完整清单。", { exact: true })
    .waitFor();
  check(
    "failed reread retains old scoped snapshot as stale",
    (await dialog().innerText()).includes("Ordinary 0") &&
      (await dialog().innerText()).includes("此前结果，已过期"),
  );
  const third = await read();
  await p.evaluate(() => window.fixture.cancelNull(true));
  await button("请求取消查询").click();
  await dialog()
    .getByText("已请求取消，尚未确认查询已结束。", { exact: true })
    .waitFor();
  check(
    "cancel null acknowledgement does not assert terminal or permit new query",
    (await button("重新查询配置").isDisabled()) &&
      !(await dialog().innerText()).includes("本次查询已取消。"),
  );
  await close();
  await p.waitForFunction(
    () =>
      window.fixture
        .current()
        .calls.filter((c) => c.cmd === "agent_extension_inventory_cancel")
        .length >= 2,
  );
  check(
    "closing retains draft and requests exact original cancellation",
    (await state()).draft.text === "KEEP P39 DRAFT" &&
      (await state()).calls
        .filter((c) => c.cmd === "agent_extension_inventory_cancel")
        .every((c) => c.args.requestId === third),
  );
  await openDetails();
  check(
    "reopening exposes still-unsettled exact operation",
    await button("检查本次查询状态").isVisible(),
  );
  await p.evaluate((id) => window.fixture.finish(id, "RETIRED_RESULT"), third);
  await p.waitForFunction(
    () => !document.body.innerText.includes("已请求取消，尚未确认查询已结束。"),
  );
  check(
    "late closed-owner result settles slot without publishing result",
    !(await dialog().innerText()).includes("RETIRED_RESULT"),
  );
  await choose("/controlled/project-B");
  const fourth = await read();
  await p.evaluate(() => window.fixture.update("fixture-b", "UNRELATED"));
  await p.waitForFunction(
    () =>
      window.fixture
        .current()
        .calls.filter((c) => c.cmd === "app_initial_snapshot").length >= 2,
  );
  await p.evaluate((id) => window.fixture.finish(id, "CURRENT_SCOPE"), fourth);
  await dialog().getByText("CURRENT_SCOPE 0", { exact: true }).waitFor();
  check("unrelated agent configuration refresh preserves current query", true);
  const fifth = await read();
  await p.evaluate(() => window.fixture.update("fixture-a", "CHANGED"));
  await p.waitForFunction(
    (id) =>
      window.fixture
        .current()
        .calls.some(
          (c) =>
            c.cmd === "agent_extension_inventory_cancel" &&
            c.args.requestId === id,
        ),
    fifth,
  );
  await p.evaluate((id) => window.fixture.finish(id, "WRONG_SELECTION"), fifth);
  await button("重新查询配置").waitFor();
  check(
    "actual selected program environment change retires old result",
    !(await dialog().innerText()).includes("WRONG_SELECTION") &&
      (await dialog().innerText()).includes("此前结果，已过期"),
  );
  await p.evaluate(() => window.fixture.refusal("selectionChanged"));
  await button("重新查询配置").click();
  await dialog()
    .getByText("Agent 或程序选择已变化，请重新检查读取方式。", { exact: true })
    .waitFor();
  check(
    "rejected capability requires explicit refresh, no auto retry",
    await button("重新查询配置").isDisabled(),
  );
  const refusals = await count("agent_extension_inventory_read");
  await p.evaluate(() => window.fixture.refusal(null));
  await button("重新检查读取方式").click();
  await p.waitForFunction(() => {
    const b = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "重新查询配置",
    );
    return b && !b.disabled;
  });
  check(
    "capability refresh alone never queries",
    (await count("agent_extension_inventory_read")) === refusals,
  );
  const sixth = await read();
  await p.evaluate((id) => window.fixture.pending(id), sixth);
  await dialog()
    .getByText("正在等待查询结束；暂不能开始新的查询。", { exact: true })
    .waitFor();
  check(
    "pending cleanup blocks successor but status/cancel remain reachable",
    (await button("重新查询配置").isDisabled()) &&
      (await button("检查本次查询状态").isEnabled()) &&
      (await button("请求取消查询").isEnabled()),
  );
  await p.evaluate((id) => window.fixture.terminal(id), sixth);
  await button("检查本次查询状态").click();
  await dialog().getByText("本次查询已取消。", { exact: true }).waitFor();
  const seventh = await read();
  await p.evaluate((id) => window.fixture.malformed(id), seventh);
  await dialog()
    .getByText("本次返回的信息无法核实，未作为清单显示。", { exact: true })
    .waitFor();
  check(
    "unknown secret-shaped response rejected without display",
    !(await dialog().innerText()).includes("CONTROLLED_SECRET_CANARY") &&
      (await button("重新查询配置").isDisabled()),
  );
  await p.evaluate((id) => window.fixture.terminal(id), seventh);
  await button("检查本次查询状态").click();
  await dialog().getByText("本次查询已取消。", { exact: true }).waitFor();

  const expired = await read();
  await p.evaluate((id) => window.fixture.absent(id), expired);
  await button("检查本次查询状态").click();
  await dialog()
    .getByText("暂时无法核实本次查询是否结束，请重新检查状态。", {
      exact: true,
    })
    .waitFor();
  check(
    "unknown request status alone does not release pending query",
    await button("重新查询配置").isDisabled(),
  );
  await button("请求取消查询").click();
  await dialog()
    .getByText("已结束这次查询的等待，结果仍未知。可明确重新查询。", {
      exact: true,
    })
    .waitFor();
  check(
    "explicit exact absence cancel releases tracking without fabricated completion",
    (await button("重新查询配置").isEnabled()) &&
      (await button("检查本次查询状态").count()) === 0 &&
      !(await dialog().innerText()).includes(
        "暂时无法核实本次查询是否结束，请重新检查状态。",
      ) &&
      !(await dialog().innerText()).includes("本次查询已取消。"),
  );
  const queryCount = (await state()).queries.length;
  await p.evaluate((id) => window.fixture.finish(id, "EXPIRED_LATE"), expired);
  check(
    "released late read cannot replace old snapshot or auto-query",
    !(await dialog().innerText()).includes("EXPIRED_LATE") &&
      (await state()).queries.length === queryCount,
  );
  await p.setViewportSize({ width: 720, height: 600 });
  const eighth = await read();
  await p.evaluate((id) => window.fixture.finish(id, "NARROW", 40), eighth);
  await dialog().getByText("NARROW 39", { exact: true }).waitFor();
  await button("选择工作文件夹").focus();
  await p.keyboard.press("Enter");
  await p.evaluate(() => window.fixture.choose(null));
  check(
    "keyboard folder chooser cancellation preserves old scope/draft",
    (await state()).draft.text === "KEEP P39 DRAFT",
  );
  const metrics = await p.evaluate(() => {
    const d = document.querySelector("dialog.agent-detail-dialog"),
      r = d.getBoundingClientRect(),
      list = d.querySelector(".agent-extension-items");
    return {
      windowY: scrollY,
      dialog: { x: r.x, y: r.y, right: r.right, bottom: r.bottom },
      width: innerWidth,
      height: innerHeight,
      listScroll: list.scrollHeight,
      listClient: list.clientHeight,
    };
  });
  check(
    "narrow dialog stays in viewport with local result scroll",
    metrics.windowY === 0 &&
      metrics.dialog.x >= 0 &&
      metrics.dialog.right <= metrics.width + 1 &&
      metrics.dialog.y >= 0 &&
      metrics.dialog.bottom <= metrics.height + 1 &&
      metrics.listScroll > metrics.listClient,
    metrics,
  );
  await p.screenshot({
    path: base + "/" + engine + "-" + label + "-narrow.png",
  });
  await close();
  check(
    "closing returns focus to original detail button",
    await p.evaluate(
      () =>
        document.activeElement?.getAttribute("aria-label") ===
        "查看详情 · Controlled A",
    ),
  );

  await openDetails();
  await choose();
  const queryBeforeSkills = (await state()).queries.length;
  await section()
    .getByLabel("清单类型", { exact: true })
    .selectOption("skills");
  check(
    "selecting skills changes only presentation, never queries",
    (await state()).queries.length === queryBeforeSkills &&
      (await button("检查技能清单").isEnabled()),
  );
  async function readSkills() {
    const n = (await state()).queries.length;
    await button(
      (await button("重新查询技能").count()) ? "重新查询技能" : "检查技能清单",
    ).click();
    await p.waitForFunction(
      (n) => window.fixture.current().queries.length === n + 1,
      n,
    );
    return (await state()).queries.at(-1).requestId;
  }
  const skill1 = await readSkills();
  check(
    "skills dispatch carries exact kind and capability ticket",
    (await state()).queries.at(-1).kind === "skills" &&
      !!(await state()).queries.at(-1).selectionId,
  );
  await p.evaluate((id) => window.fixture.skills(id, 2), skill1);
  await section().getByText("Same Skill", { exact: true }).first().waitFor();
  check(
    "disabled and duplicate skills and hidden name preserved",
    (await section().getByText("Same Skill", { exact: true }).count()) === 2 &&
      (await section().innerText()).includes("技能报告：未启用") &&
      (await section().innerText()).includes("名称未显示"),
  );
  check(
    "partial report retains readable rows and bounded description flags",
    (await section().innerText()).includes("未读取项数：2") &&
      (await section().innerText()).includes("简述已截短") &&
      (await section().innerText()).includes("简述中部分内容已过滤"),
  );
  check(
    "description is literal text, no HTML or Markdown navigation",
    (await section().locator("a").count()) === 0 &&
      (await section().innerText()).includes(
        '<a href="https://example.invalid">PLAIN</a>',
      ) &&
      (await section().innerText()).includes(
        "[Markdown](https://example.invalid)",
      ),
  );
  await section().getByText("范围与未验证事项", { exact: true }).click();
  check(
    "skill scope explains report versus loaded conversation",
    (await section().innerText()).includes("不代表当前对话已经加载或使用") &&
      (await section().innerText()).includes(
        "可能访问网络及维护自身状态或缓存",
      ),
  );
  await p.screenshot({
    path: base + "/" + engine + "-" + label + "-skills.png",
  });
  await section().getByLabel("清单类型", { exact: true }).selectOption("mcp");
  check(
    "switching back keeps old MCP report separately stale",
    (await section().innerText()).includes("NARROW 0") &&
      (await section().innerText()).includes("此前结果，已过期") &&
      !(await section().innerText()).includes("Same Skill"),
  );
  await section()
    .getByLabel("清单类型", { exact: true })
    .selectOption("skills");
  check(
    "returning skills keeps its own original report and time",
    (await section().innerText()).includes("Same Skill") &&
      !(await section().innerText()).includes("NARROW 0"),
  );
  const skill2 = await readSkills();
  await section().getByLabel("清单类型", { exact: true }).selectOption("mcp");
  await p.waitForFunction(
    (id) =>
      window.fixture
        .current()
        .calls.some(
          (c) =>
            c.cmd === "agent_extension_inventory_cancel" &&
            c.args.requestId === id,
        ),
    skill2,
  );
  check(
    "kind switch preserves actual skills pending identity and blocks MCP successor",
    (await button("重新查询配置").isDisabled()) &&
      (
        await section().locator(".agent-extension-progress").innerText()
      ).includes("本次查询类型：技能清单") &&
      (await button("请求取消查询").isEnabled()),
  );
  await p.evaluate((id) => window.fixture.skills(id), skill2);
  await p.waitForFunction(
    () => !document.querySelector(".agent-extension-progress"),
  );
  await section()
    .getByLabel("清单类型", { exact: true })
    .selectOption("skills");
  check(
    "late old-kind reply only settles, prior partial snapshot not replaced",
    (await section().innerText()).includes("未读取项数：2"),
  );
  const skill3 = await readSkills();
  await p.evaluate((id) => window.fixture.skills(id, 3, 0), skill3);
  await section().getByText("部分技能信息未能读取", { exact: false }).waitFor();
  check(
    "zero rows plus errors is partial, not an empty success",
    !(await section().innerText()).includes(
      "此次完整技能报告中没有技能项目。",
    ) && (await section().innerText()).includes("未读取项数：3"),
  );
  const skill4 = await readSkills();
  await p.evaluate((id) => window.fixture.fail(id), skill4);
  await section()
    .getByText("本次查询失败，未得到完整清单。", { exact: true })
    .waitFor();
  check(
    "failed skills reread retains scoped partial report stale",
    (await section().innerText()).includes("未读取项数：3") &&
      (await section().innerText()).includes("此前结果，已过期"),
  );
  await button("选择工作文件夹").focus();
  await p.keyboard.press("Enter");
  await p.evaluate(() => window.fixture.choose("/controlled/skills-B"));
  const skill5 = await readSkills();
  await p.evaluate((id) => window.fixture.skills(id, 0, 50), skill5);
  await section().getByText("Same Skill", { exact: true }).first().waitFor();
  const beforeCancel = await section().locator("time").innerText();
  await button("选择工作文件夹").click();
  await p.evaluate(() => window.fixture.choose(null));
  check(
    "skills picker cancel retains exact selected cwd and observation",
    (await section().locator("time").innerText()) === beforeCancel &&
      (await section().innerText()).includes("/controlled/skills-B"),
  );
  const sm = await p.evaluate(() => {
    const d = document.querySelector("dialog.agent-detail-dialog"),
      r = d.getBoundingClientRect(),
      l = d.querySelector(".agent-extension-items");
    return {
      x: r.x,
      y: r.y,
      right: r.right,
      bottom: r.bottom,
      w: innerWidth,
      h: innerHeight,
      windowY: scrollY,
      localScroll: l.scrollHeight > l.clientHeight,
    };
  });
  check(
    "skills narrow viewport uses local list scroll and reachable actions",
    sm.x >= 0 &&
      sm.y >= 0 &&
      sm.right <= sm.w + 1 &&
      sm.bottom <= sm.h + 1 &&
      sm.windowY === 0 &&
      sm.localScroll,
    sm,
  );
  await button("重新查询技能").focus();
  await p.keyboard.press("Tab");
  check(
    "keyboard navigation leaves query button without dispatch",
    (await state()).queries.at(-1).requestId === skill5 &&
      !(await button("重新查询技能").evaluate(
        (e) => e === document.activeElement,
      )),
  );
  await p.screenshot({
    path: base + "/" + engine + "-" + label + "-skills-narrow.png",
  });
  await close();
  await openDetails();
  await section()
    .getByLabel("清单类型", { exact: true })
    .selectOption("skills");
  check(
    "closed skills report returns stale and requires directory again",
    (await button("重新查询技能").isDisabled()) &&
      (await section().innerText()).includes("此前结果，已过期"),
  );
  await choose();
  const skill6 = await readSkills();
  await close();
  await openDetails("B");
  await section()
    .getByLabel("清单类型", { exact: true })
    .selectOption("skills");
  await p.evaluate((id) => window.fixture.skills(id), skill6);
  check(
    "late skills reply from closed Agent A never enters B",
    !(await section().innerText()).includes("Same Skill"),
  );
  await close();
  await p.evaluate(() => window.fixture.capability("hold"));
  await p
    .getByRole("button", { name: "查看详情 · Controlled A", exact: true })
    .click();
  await p.waitForFunction(() => window.fixture.current().held === 1);
  await close();
  await p.evaluate(() => window.fixture.capability("notReviewed"));
  await p
    .getByRole("button", { name: "查看详情 · Controlled B", exact: true })
    .click();
  await dialog()
    .getByText("此 Agent 的官方清单读取方式尚未核实。", { exact: true })
    .waitFor();
  await p.evaluate(() => window.fixture.releaseCapabilities());
  check(
    "late capability from closed A cannot authorize B",
    (await button("选择工作文件夹").count()) === 0,
  );
  await close();
  await p.evaluate(() => window.fixture.capability("notReviewed"));
  await p
    .getByRole("button", { name: "查看详情 · Controlled B", exact: true })
    .click();
  await dialog()
    .getByText("此 Agent 的官方清单读取方式尚未核实。", { exact: true })
    .waitFor();
  check(
    "unreviewed agent has no query control",
    (await button("检查 MCP 配置").count()) === 0 &&
      (await button("选择工作文件夹").count()) === 0,
  );
  r.final = await state();
  check(
    "journey never opens/sends an Agent request and never writes CLI configuration",
    !r.final.calls.some((c) =>
      ["session_open", "session_prompt", "agent_connect"].includes(c.cmd),
    ) && r.final.unexpected.length === 0,
  );
  check(
    "original draft and cwd remain exact",
    r.final.draft.text === "KEEP P39 DRAFT" && r.final.cwd === baseline.cwd,
  );
  r.body = await p.locator("body").innerText();
} catch (error) {
  r.failure = String(error);
  r.body = await p
    .locator("body")
    .innerText()
    .catch(() => null);
  await p
    .screenshot({ path: base + "/" + engine + "-" + label + "-failure.png" })
    .catch(() => {});
  r.state = await state().catch(() => null);
} finally {
  await b.close();
  r.after = hashes();
  r.stable = JSON.stringify(r.before) === JSON.stringify(r.after);
  r.passed =
    !r.failure &&
    r.errors.length === 0 &&
    r.stable &&
    r.checks.every((c) => c.pass);
  fs.writeFileSync(
    base + "/" + engine + "-" + label + ".raw.txt",
    JSON.stringify(r, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      passed: r.passed,
      checks: r.checks.length,
      failure: r.failure,
      errors: r.errors,
    }),
  );
  process.exitCode = r.passed ? 0 : 1;
}
