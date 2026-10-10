import { suite } from "./browser-common.mjs";
const engine = process.argv[2] ?? "webkit",
  label = process.argv[3] ?? "app-first";
const p = (page, text) =>
  page.locator(".document-paragraph").filter({
    has: page.locator("p", { hasText: new RegExp("^" + text + "$") }),
  });
const select = async (locator, type = "paragraph") =>
  locator
    .getByRole("button", {
      name: type === "paragraph" ? "选择整个段落" : "选择整个表格",
      exact: true,
    })
    .click();
const body = (elementPath, blockKind = "paragraph") => ({
  part: "word/document.xml",
  elementPath,
  blockKind,
});
const scenarios = [
  {
    name: "repeated",
    file: "repeated-locations.docx",
    async run({
      page,
      engine,
      check,
      feedback,
      latest,
      root,
      confirm,
      anchor,
      original,
    }) {
      const repeated = p(page, "DUPLICATE 0 false cafe");
      await repeated.first().waitFor();
      const first = repeated.nth(0);
      await first
        .getByRole("button", { name: "选择整个段落", exact: true })
        .focus();
      await page.keyboard.press("Enter");
      check(
        "StrictMode first selection announces confirmation without writing",
        (await first
          .getByRole("button", { name: "对此段落提意见", exact: true })
          .count()) === 1 && (await feedback()).length === 0,
      );
      await page.keyboard.press(engine === "webkit" ? "Alt+Tab" : "Tab");
      check(
        "keyboard reaches explicit confirmation",
        await first
          .getByRole("button", { name: "对此段落提意见", exact: true })
          .evaluate((e) => e === document.activeElement),
      );
      await page.keyboard.press("Enter");
      await page.getByLabel("补充给 Agent 的意见", { exact: true }).waitFor();
      await anchor("first equal text original path", body([0, 1]));
      await page
        .getByLabel("补充给 Agent 的意见", { exact: true })
        .fill("保留受控意见，不自动发送。");
      const prior = await latest();
      await select(repeated.nth(1));
      check(
        "new candidate does not rewrite saved target",
        JSON.stringify(await latest()) === JSON.stringify(prior),
      );
      await confirm();
      await anchor("second equal text distinct original path", body([0, 3]));
      check(
        "explicit retarget preserves opinion text",
        (await latest()).text === prior.text,
      );
      const table = page.locator(".document-table").first();
      await select(table, "table");
      await confirm("table");
      await anchor("whole table original path", body([0, 5], "table"));
      await table.locator('[data-document-cell="0:0"]').click();
      check(
        "table candidate withdrawn on cell detail",
        (await page
          .getByRole("button", { name: "对此表格提意见", exact: true })
          .count()) === 0,
      );
      await select(
        page.locator(".document-cell-detail .document-paragraph").first(),
      );
      await confirm();
      await anchor(
        "first cell paragraph original hierarchy",
        body([0, 5, 2, 0, 1]),
      );
      await page.getByRole("button", { name: "返回表格", exact: true }).click();
      await table.locator('[data-document-cell="0:1"]').click();
      await select(
        page.locator(".document-cell-detail .document-paragraph").first(),
      );
      await confirm();
      await anchor(
        "second identical cell has distinct path",
        body([0, 5, 2, 1, 1]),
      );
      for (const [label, part] of [
        ["页眉", "word/header1.xml"],
        ["页脚", "word/footer1.xml"],
      ]) {
        const value = await page
          .getByLabel("文档区域", { exact: true })
          .locator("option")
          .evaluateAll(
            (options, prefix) =>
              options.find((o) => o.textContent.trim().startsWith(prefix))
                .value,
            label,
          );
        await page.getByLabel("文档区域", { exact: true }).selectOption(value);
        check(
          label + " navigation withdraws previous confirmation",
          (await page
            .getByRole("button", { name: "对此段落提意见", exact: true })
            .count()) === 0,
        );
        await select(p(page, "DUPLICATE 0 false cafe"));
        await confirm();
        await anchor(label + " identical text keeps actual part", {
          part,
          elementPath: [0],
          blockKind: "paragraph",
        });
      }
      await root("opinion focused long composer");
      await page.evaluate(() => window.fixture.saveNow());
      const cold = await page.evaluate(() => window.fixture.parseSaved());
      check(
        "strict cold parser retains source anchor",
        !!cold && JSON.stringify(cold).includes("word/footer1.xml"),
      );
      await page
        .locator(".artifact-feedback")
        .getByRole("button", { name: "加入对话", exact: true })
        .click();
      const composer = await page.evaluate(
        () => window.fixture.composer().text,
      );
      check(
        "take preserves original input and adds opinion once",
        composer.startsWith(original + "\n\n") &&
          composer.split(prior.text).length === 2 &&
          (await feedback()).length === 0,
      );
      await root("after take");
    },
  },
  {
    name: "choice",
    file: "supported-choice-markers.docx",
    async run({ page, check, confirm, anchor, root }) {
      await p(page, "CHOICE VISIBLE 同文").waitFor();
      await select(p(page, "CHOICE VISIBLE 同文"));
      await confirm();
      await anchor("supported Choice keeps wrapper path", body([0, 1, 0, 0]));
      check(
        "unselected Fallback absent",
        !(await page.locator(".document-preview").innerText()).includes(
          "FALLBACK MUST NOT DISPLAY",
        ),
      );
      await select(p(page, "AFTER MARKER"));
      await confirm();
      await anchor(
        "ignored markers still count in original path",
        body([0, 3]),
      );
      await root("choice opinion");
    },
  },
  {
    name: "hidden",
    file: "hidden-notice-boundaries.docx",
    async run({ page, check, confirm, anchor, root }) {
      await page.locator(".document-paragraph").first().waitFor();
      const paras = page.locator(".document-paragraph");
      check("five actual source paragraphs", (await paras.count()) === 5);
      check(
        "hidden-only has no feedback control",
        (await paras
          .nth(0)
          .getByRole("button", { name: "选择整个段落", exact: true })
          .count()) === 0,
      );
      await select(paras.nth(1));
      await confirm();
      await anchor("real empty paragraph whole source eligible", body([0, 2]));
      await select(paras.nth(2));
      await confirm();
      await anchor(
        "mixed notice paragraph retains original path",
        body([0, 3]),
      );
      check(
        "notice remains visible with eligible mixed content",
        (await paras.nth(2).innerText()).includes("隐藏文字未显示"),
      );
      check(
        "field notice only ineligible",
        (await paras
          .nth(3)
          .getByRole("button", { name: "选择整个段落", exact: true })
          .count()) === 0,
      );
      const text = await page.locator(".document-preview").innerText();
      check(
        "hidden and omitted literal content not leaked",
        !text.includes("HIDDEN ONLY MUST NOT LEAK") &&
          !text.includes("MIXED HIDDEN MUST NOT LEAK") &&
          !text.includes("OMITTED CONTENT MUST NOT LEAK"),
      );
      await root("notice mixed opinion");
    },
  },
  {
    name: "nested",
    file: "nested-choice-fallback.docx",
    async run({ page, check }) {
      await page
        .getByRole("alert")
        .filter({ hasText: "暂不支持此文档内容" })
        .waitFor();
      check(
        "unsupported nested content has no target",
        (await page.locator("[data-document-feedback]").count()) === 0,
      );
      check(
        "general feedback unavailable before ready",
        await page
          .getByRole("button", { name: "修改意见", exact: true })
          .isDisabled(),
      );
    },
  },
  {
    name: "windows",
    file: "window-boundaries.docx",
    viewport: { width: 900, height: 620 },
    async run({ page, check, latest, confirm, anchor, root }) {
      const paragraph = page.locator(".document-paragraph").first();
      await paragraph.waitFor();
      await select(paragraph);
      await confirm();
      await anchor("long paragraph full source", body([0, 0]));
      const old = await latest();
      await paragraph
        .getByRole("button", { name: "下一部分", exact: true })
        .click();
      check(
        "long fragment retires confirmation without changing draft",
        (await page
          .getByRole("button", { name: "对此段落提意见", exact: true })
          .count()) === 0 &&
          JSON.stringify(await latest()) === JSON.stringify(old),
      );
      check(
        "second fragment actual tail visible",
        (await paragraph.innerText()).includes("END LONG SOURCE"),
      );
      await select(paragraph);
      await confirm();
      await anchor("fragment still whole original paragraph", body([0, 0]));
      const table = page.locator(".document-table");
      await select(table, "table");
      await confirm("table");
      await anchor("window table original source", body([0, 1], "table"));
      await table
        .getByRole("button", { name: "下一组行", exact: true })
        .click();
      check(
        "row window retires selection",
        (await page
          .getByRole("button", { name: "对此表格提意见", exact: true })
          .count()) === 0,
      );
      await table
        .getByRole("button", { name: "下一组列", exact: true })
        .click();
      await select(table, "table");
      await confirm("table");
      await anchor(
        "clipped window retains whole table source",
        body([0, 1], "table"),
      );
      await table.locator('[data-document-cell="20:12"]').click();
      await select(page.locator(".document-cell-detail .document-paragraph"));
      await confirm();
      await anchor(
        "last cell original indexes not window indexes",
        body([0, 1, 21, 12, 0]),
      );
      await page
        .getByLabel("补充给 Agent 的意见", { exact: true })
        .fill("窄窗意见保持可达。");
      await root("narrow window detail and opinion");
    },
  },
];
await suite(
  engine,
  label,
  process.argv[4] === "hidden-only"
    ? scenarios.filter((x) => x.name === "hidden")
    : scenarios,
  process.argv[4] === "candidate",
);
