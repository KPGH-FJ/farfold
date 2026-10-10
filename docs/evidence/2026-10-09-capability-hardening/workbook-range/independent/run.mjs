import { suite } from "./browser-common.mjs";
const engine = process.argv[2],
  label = process.argv[3];
const open = async (p) => {
  if (
    !(await p.getByRole("textbox", { name: "意见范围", exact: true }).count())
  )
    await p.getByRole("button", { name: "选择意见范围", exact: true }).click();
};
const select = async (p, text) => {
  await open(p);
  await p.getByRole("textbox", { name: "意见范围", exact: true }).fill(text);
  await p
    .getByRole("textbox", { name: "意见范围", exact: true })
    .press("Enter");
};
const confirm = async (p) => {
  await p.getByRole("button", { name: "对此范围提意见", exact: true }).click();
  await p.getByLabel("补充给 Agent 的意见", { exact: true }).waitFor();
};
const expected = (id, name, r) => ({
  kind: "xlsx-range",
  sheetId: id,
  sheetName: name,
  ...r,
});
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cases = [
  {
    name: "literal-partial-cross-maximum",
    file: "range-layout.xlsx",
    async run({ page, check, latest, feedback, root, original, record }) {
      const sheet = await page
        .getByLabel("工作表", { exact: true })
        .inputValue();
      check("actual nonnumeric relation id", sheet === "Rdc1d8e8f2cb54514");
      check(
        "numeric zero visible",
        (await page.locator('[data-cell="A2"] button').innerText()) === "0",
      );
      check(
        "boolean false visible",
        (
          await page.locator('[data-cell="B2"] button').innerText()
        ).toLowerCase() === "false",
      );
      for (const [text, r, merge] of [
        ["B3:G6", { fromRow: 3, toRow: 6, fromColumn: 2, toColumn: 7 }, null],
        [
          "D8:E8",
          { fromRow: 8, toRow: 8, fromColumn: 4, toColumn: 5 },
          "C8:F9",
        ],
        [
          "W98:AB103",
          { fromRow: 98, toRow: 103, fromColumn: 23, toColumn: 28 },
          "W103:X104",
        ],
        [
          "Z101:AC103",
          { fromRow: 101, toRow: 103, fromColumn: 26, toColumn: 29 },
          "X99:AA102",
        ],
        [
          "XFC1048575:XFD1048576",
          {
            fromRow: 1048575,
            toRow: 1048576,
            fromColumn: 16383,
            toColumn: 16384,
          },
          null,
        ],
        [
          "A1:XFD1048576",
          { fromRow: 1, toRow: 1048576, fromColumn: 1, toColumn: 16384 },
          null,
        ],
      ]) {
        const before = await feedback();
        await select(page, text);
        await page
          .getByRole("button", { name: "对此范围提意见", exact: true })
          .waitFor();
        check("select not confirm " + text, equal(await feedback(), before));
        if (merge) {
          await page.getByText(/涉及的完整合并范围/).click();
          const text = await page
            .locator(".workbook-range-summary")
            .innerText();
          check(
            "partial merge exact disclosure " + merge,
            text.includes(merge),
          );
          if (merge === "X99:AA102")
            check(
              "no cascade enlargement disclosure",
              !text.includes("W103:X104"),
            );
        }
        await confirm(page);
        check(
          "exact coordinate " + text,
          equal((await latest()).anchor, expected(sheet, "范围'与&0", r)),
          (await latest()).anchor,
        );
        check(
          "bounded DOM for " + text,
          (await page.locator(".workbook-grid td").count()) <= 2400,
        );
      }
      await page
        .getByLabel("补充给 Agent 的意见", { exact: true })
        .fill("保留既有意见，矩形不扩大。");
      const before = await feedback();
      await page
        .getByRole("textbox", { name: "意见范围", exact: true })
        .fill("Sheet!A1");
      await page
        .getByRole("textbox", { name: "意见范围", exact: true })
        .press("Enter");
      check(
        "invalid withdraws confirm",
        (await page
          .getByRole("button", { name: "对此范围提意见", exact: true })
          .count()) === 0,
      );
      check("invalid retains prior opinion", equal(await feedback(), before));
      await page.getByRole("button", { name: "取消选择", exact: true }).click();
      check(
        "cancel returns focus",
        await page
          .getByRole("button", { name: "选择意见范围", exact: true })
          .evaluate((e) => document.activeElement === e),
      );
      check(
        "composer unchanged",
        (await page.evaluate(() => window.fixture.composer().text)) ===
          original,
      );
      await page.evaluate(() => window.fixture.saveNow());
      const cold = await page.evaluate(() =>
        window.fixture
          .parseSaved()
          .feedback.flatMap(([, items]) => Object.values(items)),
      );
      check(
        "cold raw draft parse preserves exact anchor",
        equal(cold.at(-1).anchor, (await latest()).anchor),
      );
      await page.getByRole("button", { name: "加入对话", exact: true }).click();
      const taken = await page.evaluate(() => window.fixture.composer().text);
      check(
        "take appends to original exactly once",
        taken.startsWith(original) &&
          taken.split("A1:XFD1048576").length === 2 &&
          taken.split("保留既有意见，矩形不扩大。").length === 2,
      );
      check(
        "take removes only consumed opinion",
        (await feedback()).every((x) => !x.text),
      );
      await root("max range and opinion");
    },
  },
  {
    name: "hidden-ack-sheet-retire",
    file: "range-nonordinal-hidden.xlsx",
    viewport: { width: 900, height: 620 },
    async run({ page, check, latest, feedback, root }) {
      check(
        "actual remapped first id",
        (await page.getByLabel("工作表", { exact: true }).inputValue()) ===
          "sheet-main-A9",
      );
      await select(page, "B20:E24");
      check(
        "hidden needs explicit confirmation",
        (await page
          .getByRole("button", { name: "对此范围提意见", exact: true })
          .count()) === 0,
      );
      await page.getByText(/隐藏行位置/).click();
      await page.getByText(/隐藏列位置/).click();
      const summary = await page.locator(".workbook-range-summary").innerText();
      check(
        "hidden interior coordinates declared",
        summary.includes("22") && summary.includes("D"),
      );
      check(
        "hidden values not revealed",
        !(await page.locator(".workbook-preview").innerText()).includes(
          "HIDDEN ROW22",
        ) && (await page.locator('[data-cell="C22"] button').count()) === 0,
      );
      check(
        "showHidden unchanged",
        !(await page.getByLabel("显示隐藏行列", { exact: true }).isChecked()),
      );
      await page.getByLabel("范围包括这些隐藏行列", { exact: true }).check();
      await confirm(page);
      check(
        "exact hidden anchor",
        equal(
          (await latest()).anchor,
          expected("sheet-main-A9", "范围'与&0", {
            fromRow: 20,
            toRow: 24,
            fromColumn: 2,
            toColumn: 5,
          }),
        ),
        await latest(),
      );
      const before = await feedback();
      await select(page, "E24:B20");
      check(
        "reverse normalized",
        (await page
          .getByRole("textbox", { name: "意见范围", exact: true })
          .inputValue()) === "B20:E24",
      );
      check(
        "edit revoked prior hidden ack",
        !(await page
          .getByLabel("范围包括这些隐藏行列", { exact: true })
          .isChecked()) &&
          (await page
            .getByRole("button", { name: "对此范围提意见", exact: true })
            .count()) === 0,
      );
      check("edit keeps prior opinion", equal(await feedback(), before));
      await page
        .getByLabel("工作表", { exact: true })
        .selectOption("sheet-other-17");
      await page.locator('[data-cell="A2"] button').waitFor();
      check(
        "switch retires old form",
        (await page
          .getByRole("textbox", { name: "意见范围", exact: true })
          .count()) === 0,
      );
      await select(page, "B3:G6");
      check(
        "second sheet requires fresh hidden acknowledgement",
        !(await page
          .getByLabel("范围包括这些隐藏行列", { exact: true })
          .isChecked()),
      );
      await page.getByLabel("范围包括这些隐藏行列", { exact: true }).check();
      await confirm(page);
      check(
        "second actual sheet identity",
        (await latest()).anchor.sheetId === "sheet-other-17" &&
          (await latest()).anchor.sheetName === "同文副页",
      );
      await root("hidden rectangle and opinion");
    },
  },
  {
    name: "editing-defers-manual-hide-and-version",
    file: "range-layout.xlsx",
    async run({ page, check, latest, feedback, root, record }) {
      await open(page);
      await page
        .getByRole("textbox", { name: "意见范围", exact: true })
        .fill("invalid:");
      await page.evaluate(() =>
        window.fixture.replace("range-nonordinal-hidden.xlsx"),
      );
      const before = await page.evaluate(
        () =>
          window.calls.filter((x) => x.cmd === "file_delivery_read_workbook")
            .length,
      );
      await page.waitForTimeout(5200);
      check(
        "invalid range edit holds automatic replacement",
        (await page.getByLabel("工作表", { exact: true }).inputValue()) ===
          "Rdc1d8e8f2cb54514" &&
          (await page.evaluate(
            () =>
              window.calls.filter(
                (x) => x.cmd === "file_delivery_read_workbook",
              ).length,
          )) === before,
      );
      await page.getByRole("button", { name: "取消选择", exact: true }).click();
      check(
        "deferred change explicitly requires reread",
        (await page.locator(".file-artifact-view").innerText()).includes(
          "文件已变化",
        ),
      );
      await page.getByRole("button", { name: "重新读取", exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector('select[aria-label="工作表"]')?.value ===
          "sheet-main-A9",
        {},
        { timeout: 12000 },
      );
      check(
        "explicit reread after editing release",
        (await page.getByLabel("工作表", { exact: true }).inputValue()) ===
          "sheet-main-A9",
      );
      check(
        "reread without feedback side effect",
        (await feedback()).length === 0,
      );
      await select(page, "B3:C6");
      await confirm(page);
      await page
        .getByLabel("补充给 Agent 的意见", { exact: true })
        .fill("旧版意见保护");
      const old = await feedback();
      await select(page, "B3:C6");
      await page
        .locator("aside.artifact-pane")
        .getByRole("button", { name: "收起对话内容", exact: true })
        .click();
      await page.locator(".workbook-preview").waitFor({ state: "hidden" });
      await page
        .getByRole("button", { name: "查看对话内容", exact: true })
        .click();
      await page.locator('[data-cell="A2"] button').waitFor();
      check(
        "hide/reopen has no revived rectangle confirmation",
        (await page
          .getByRole("button", { name: "对此范围提意见", exact: true })
          .count()) === 0,
      );
      check("hide keeps opinion", equal(await feedback(), old));
      await page.evaluate(() => window.fixture.replace("range-layout.xlsx"));
      await page.getByRole("button", { name: "重新读取", exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector('select[aria-label="工作表"]')?.value ===
          "Rdc1d8e8f2cb54514",
      );
      check(
        "manual new revision retains previous opinion",
        equal(await feedback(), old),
      );
      check(
        "manual read does not revive old candidate",
        (await page
          .getByRole("button", { name: "对此范围提意见", exact: true })
          .count()) === 0,
      );
      await select(page, "W98:AB103");
      await confirm(page);
      const both = await feedback();
      check(
        "new version anchor kept separate",
        both.length === 2 &&
          both[0].contentId !== both[1].contentId &&
          equal(both[0], old[0]) &&
          both[1].anchor.sheetId === "Rdc1d8e8f2cb54514",
      );
      await root("post refresh");
    },
  },
];
cases.push({
  name: "unblocked-automatic-stage",
  file: "range-layout.xlsx",
  async run({ page, check, root }) {
    await page.evaluate(() => {
      window.fixture.blockCapture();
      window.fixture.replace("range-nonordinal-hidden.xlsx");
    });
    await page.waitForFunction(
      () =>
        window.calls.filter((x) => x.cmd === "file_delivery_read_workbook")
          .length === 2,
      {},
      { timeout: 12000 },
    );
    check(
      "held automatic parse keeps old grid",
      (await page.getByLabel("工作表", { exact: true }).inputValue()) ===
        "Rdc1d8e8f2cb54514" &&
        (await page.locator('[data-cell="A2"] button').innerText()) === "0",
    );
    check(
      "held stage is inert",
      await page.locator(".workbook-preview").evaluate((e) => e.inert),
    );
    check(
      "no target confirmation in stage",
      (await page
        .getByRole("button", { name: "对此范围提意见", exact: true })
        .count()) === 0,
    );
    await page.evaluate(() => window.fixture.releaseCapture());
    await page.waitForFunction(
      () =>
        document.querySelector('select[aria-label="工作表"]')?.value ===
        "sheet-main-A9",
      {},
      { timeout: 12000 },
    );
    check(
      "new actual worker snapshot becomes ready",
      !(await page.locator(".workbook-preview").evaluate((e) => e.inert)),
    );
    await page
      .getByRole("button", { name: "选择意见范围", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await page
      .getByRole("textbox", { name: "意见范围", exact: true })
      .fill("B3:C6");
    await page
      .getByRole("textbox", { name: "意见范围", exact: true })
      .press("Enter");
    const confirm = page.getByRole("button", {
      name: "对此范围提意见",
      exact: true,
    });
    await confirm.focus();
    await page.keyboard.press("Enter");
    check(
      "keyboard confirm uses new version",
      (await page.evaluate(
        () => Object.values(window.fixture.feedback()).at(-1).anchor.sheetId,
      )) === "sheet-main-A9",
    );
    await root("automatic final");
  },
});
await suite(engine, label, cases);
