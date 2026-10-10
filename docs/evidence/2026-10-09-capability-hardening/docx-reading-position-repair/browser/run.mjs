import { suite } from "./browser-common.mjs";
const engine = process.argv[2],
  label = process.argv[3];
if (!["webkit", "chromium"].includes(engine) || !label)
  throw Error("engine and unique label required");
const scenarios = [];
for (const mode of ["pane", "link"])
  for (const target of ["paragraph", "table"])
    scenarios.push({
      name: `${mode}-${target}`,
      file: "window-boundaries.docx",
      viewport: { width: 1280, height: 820 },
      async run({
        page,
        check,
        latest,
        feedback,
        confirm,
        root,
        original,
        record,
      }) {
        const paragraph = page.locator(".document-paragraph").first(),
          table = page.locator(".document-table");
        await paragraph
          .getByRole("button", { name: "下一部分", exact: true })
          .click();
        await table
          .getByRole("button", { name: "下一组行", exact: true })
          .click();
        await table
          .getByRole("button", { name: "下一组列", exact: true })
          .click();
        check(
          "actual long paragraph second part before hide",
          (await paragraph.innerText()).includes("END LONG SOURCE"),
        );
        check(
          "actual table last window before hide",
          (await table.innerText()).includes("第 21–21 行，第 13–13 列"),
          await table.innerText(),
        );
        await table
          .getByRole("button", { name: "选择整个表格", exact: true })
          .click();
        await confirm("table");
        await page
          .getByLabel("补充给 Agent 的意见", { exact: true })
          .fill("受控阅读位置意见，不自动发送。");
        check(
          "whole table target is original XML path",
          JSON.stringify((await latest()).anchor?.elementPath) === "[0,1]",
          await latest(),
        );
        const before = await feedback();
        const collapse = page
          .getByRole("button", { name: "收起对话内容", exact: true })
          .first();
        await collapse.focus();
        await page.keyboard.press("Space");
        await page.locator(".document-preview").waitFor({ state: "hidden" });
        check(
          "hide retires candidate",
          (await page
            .getByRole("button", { name: "对此表格提意见", exact: true })
            .count()) === 0,
        );
        await page
          .getByRole("button", {
            name: mode === "link" ? "文档样本" : "查看对话内容",
            exact: true,
          })
          .click();
        await paragraph
          .getByRole("button", { name: "选择整个段落", exact: true })
          .waitFor();
        const paragraphText = await paragraph.innerText(),
          tableText = await table.innerText();
        record.restored = {
          paragraphSecond: paragraphText.includes("END LONG SOURCE"),
          tableLast: tableText.includes("第 21–21 行，第 13–13 列"),
          tableText,
        };
        check(
          target + " exact window retained",
          target === "paragraph"
            ? record.restored.paragraphSecond
            : record.restored.tableLast,
          record.restored,
        );
        check(
          "historical opinion bytes preserved",
          JSON.stringify(await feedback()) === JSON.stringify(before),
        );
        check(
          "original composer unchanged",
          (await page.evaluate(() => window.fixture.composer().text)) ===
            original,
        );
        check(
          "no old confirm revived",
          (await page
            .getByRole("button", { name: "对此表格提意见", exact: true })
            .count()) === 0,
        );
        await root("reopened reading window and feedback");
        const counts = await page.evaluate(
          () =>
            window.calls.filter((x) => x.cmd === "file_delivery_read_docx")
              .length,
        );
        check(
          "read ownership preserved",
          counts === (mode === "link" ? 2 : 1),
          { counts, mode },
        );
      },
    });
await suite(engine, label, scenarios);
