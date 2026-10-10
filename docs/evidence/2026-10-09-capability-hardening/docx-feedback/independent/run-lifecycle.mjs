import { suite } from "./browser-common.mjs";
const engine = process.argv[2] ?? "webkit",
  label = process.argv[3] ?? "lifecycle-first";
const select = (page) =>
  page
    .getByRole("button", { name: "选择整个段落", exact: true })
    .first()
    .click();
const choice = (page) =>
  page
    .locator(".document-paragraph p")
    .filter({ hasText: "CHOICE VISIBLE 同文" });
const reads = (page) =>
  page.evaluate(() =>
    window.calls.filter((c) => c.cmd === "file_delivery_read_docx"),
  );
const scenarios = [
  {
    name: "automatic",
    file: "repeated-locations.docx",
    async run({ page, check, feedback, confirm, anchor, root }) {
      await page.locator(".document-paragraph").first().waitFor();
      check(
        "ready starts without draft/candidate",
        (await feedback()).length === 0 &&
          (await page
            .getByRole("button", { name: "对此段落提意见", exact: true })
            .count()) === 0,
      );
      await page.evaluate(() => {
        window.fixture.blockCapture();
        window.fixture.replace("supported-choice-markers.docx");
        window.dispatchEvent(new Event("focus"));
      });
      await page.waitForFunction(() =>
        window.calls.some(
          (x) =>
            x.cmd === "file_delivery_read_docx" &&
            x.args.file.version === "controlled:supported-choice-markers.docx",
        ),
      );
      check(
        "stage preserves actual old document",
        (await page.locator(".document-preview").innerText()).includes(
          "DUPLICATE 0 false cafe",
        ),
      );
      check(
        "stage withholds unparsed new document",
        (await choice(page).count()) === 0,
      );
      check(
        "stage is inert and opinion disabled",
        (await page.locator(".document-preview").evaluate((e) => e.inert)) &&
          (await page
            .getByRole("button", { name: "修改意见", exact: true })
            .isDisabled()),
      );
      const button = page
        .getByRole("button", { name: "选择整个段落", exact: true })
        .first();
      const box = await button.boundingBox();
      if (!box) throw new Error("old paragraph button no layout");
      await page.mouse.click(box.x + 8, box.y + 8);
      check(
        "real pointer cannot choose old inert paragraph",
        (await page
          .getByRole("button", { name: "对此段落提意见", exact: true })
          .count()) === 0,
      );
      const region = page.getByLabel("文档区域", { exact: true });
      const previous = await region.inputValue(),
        regionBox = await region.boundingBox();
      await page.mouse.click(regionBox.x + 15, regionBox.y + 10);
      await page.keyboard.press("ArrowDown");
      check(
        "inert region cannot navigate by actual pointer/key",
        (await region.inputValue()) === previous,
      );
      await page.evaluate(() => window.fixture.releaseCapture());
      await choice(page).waitFor();
      check(
        "prepared parse has one native capture",
        (await reads(page)).filter(
          (x) =>
            x.args.file.version === "controlled:supported-choice-markers.docx",
        ).length === 1,
      );
      check(
        "new document no automatic opinion",
        (await feedback()).length === 0,
      );
      await select(page);
      await confirm();
      await anchor("new actual source confirm", {
        part: "word/document.xml",
        elementPath: [0, 1, 0, 0],
        blockKind: "paragraph",
      });
      await root("automatic replacement");
    },
  },
  {
    name: "cancel",
    file: "supported-choice-markers.docx",
    async run({ page, check, feedback, root }) {
      await choice(page).waitFor();
      await select(page);
      await page.getByRole("button", { name: "取消选择", exact: true }).click();
      check(
        "explicit cancel removes candidate and returns focus",
        (await page
          .getByRole("button", { name: "对此段落提意见", exact: true })
          .count()) === 0 &&
          (await page
            .getByRole("button", { name: "选择整个段落", exact: true })
            .first()
            .evaluate((e) => e === document.activeElement)),
      );
      check("cancel does not create opinion", (await feedback()).length === 0);
      await page.evaluate(() => {
        window.fixture.replace("repeated-locations.docx");
        window.dispatchEvent(new Event("focus"));
      });
      await page
        .locator(".document-paragraph p")
        .filter({ hasText: "DUPLICATE 0 false cafe" })
        .first()
        .waitFor();
      check(
        "cancelled candidate no longer blocks automatic adoption",
        (await reads(page)).filter(
          (x) => x.args.file.version === "controlled:repeated-locations.docx",
        ).length === 1,
      );
      await root("after cancel adoption");
    },
  },
  {
    name: "hide-version",
    file: "repeated-locations.docx",
    async run({
      page,
      check,
      feedback,
      latest,
      confirm,
      anchor,
      root,
      original,
    }) {
      await page.locator(".document-paragraph").first().waitFor();
      await select(page);
      await confirm();
      await page
        .getByLabel("补充给 Agent 的意见", { exact: true })
        .fill("旧文档版本意见保持。");
      const old = await feedback(),
        oldReads = (await reads(page)).length;
      await page.evaluate(() => {
        window.fixture.replace("supported-choice-markers.docx");
        window.dispatchEvent(new Event("focus"));
      });
      await page
        .getByText(
          "文件已变化。当前内容和意见保持不变，重新读取可查看新内容。",
          { exact: true },
        )
        .waitFor();
      check(
        "editing candidate defers capture and leaves original group",
        (await reads(page)).length === oldReads &&
          JSON.stringify(await feedback()) === JSON.stringify(old),
      );
      await page.evaluate(() => window.fixture.blockCapture());
      await page.getByRole("button", { name: "重新读取", exact: true }).click();
      await page.waitForFunction(() =>
        window.calls.some(
          (x) =>
            x.cmd === "file_delivery_read_docx" &&
            x.args.file.version === "controlled:supported-choice-markers.docx",
        ),
      );
      check(
        "manual reload removes old candidate and blocks entry",
        (await page
          .getByRole("button", { name: "对此段落提意见", exact: true })
          .count()) === 0 &&
          (await page
            .getByRole("button", { name: "修改意见", exact: true })
            .isDisabled()),
      );
      check(
        "manual reload retains historical opinion",
        JSON.stringify(await feedback()) === JSON.stringify(old),
      );
      await page
        .getByRole("button", { name: "收起对话内容", exact: true })
        .first()
        .click();
      await page.evaluate(() => window.fixture.releaseCapture());
      await page.waitForTimeout(100);
      check(
        "hidden late completion cannot retarget",
        JSON.stringify(await feedback()) === JSON.stringify(old) &&
          (await page
            .getByRole("button", { name: "对此段落提意见", exact: true })
            .count()) === 0,
      );
      await page
        .getByRole("button", { name: "查看对话内容", exact: true })
        .click();
      await choice(page).waitFor();
      check(
        "reopened new content keeps old group exact",
        JSON.stringify(await feedback()) === JSON.stringify(old),
      );
      await select(page);
      await confirm();
      await anchor("new version exact wrapper path", {
        part: "word/document.xml",
        elementPath: [0, 1, 0, 0],
        blockKind: "paragraph",
      });
      await page
        .getByLabel("补充给 Agent 的意见", { exact: true })
        .fill("新文档版本意见明确确认。");
      const next = await feedback();
      check(
        "new same-path version gets separate group",
        next.length === 2 &&
          JSON.stringify(next.find((x) => x.contentId === old[0].contentId)) ===
            JSON.stringify(old[0]),
      );
      await page.evaluate(() => window.fixture.saveNow());
      check(
        "cold parse accepts two anchored versions",
        !!(await page.evaluate(() => window.fixture.parseSaved())),
      );
      await page
        .locator(".artifact-feedback")
        .getByRole("button", { name: "加入对话", exact: true })
        .click();
      const composer = await page.evaluate(
        () => window.fixture.composer().text,
      );
      check(
        "take once preserves composer and old version",
        composer.startsWith(original + "\n\n") &&
          composer.split("新文档版本意见明确确认。").length === 2 &&
          JSON.stringify(await feedback()) === JSON.stringify(old),
      );
      await root("version take");
    },
  },
];
await suite(engine, label, scenarios);
