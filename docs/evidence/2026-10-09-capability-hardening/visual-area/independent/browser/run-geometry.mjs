import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const { webkit, chromium } =
  await import("/Users/tw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const base =
  "docs/evidence/2026-10-09-capability-hardening/visual-area/independent/browser";
const fixtures = base.replace("/independent/browser", "/fixtures");
const oracle = JSON.parse(fs.readFileSync(fixtures + "/oracle.json", "utf8"));
const engine = process.argv[2] ?? "webkit";
const label = process.argv[3] ?? "geometry-first";
const walk = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
const inputs = [
  ...walk("src"),
  ...walk(fixtures),
  ...[
    "fixture.tsx",
    "index.html",
    "capture-data.json",
    "serve.mjs",
    "run-geometry.mjs",
  ].map((p) => base + "/" + p),
];
const hashes = () =>
  Object.fromEntries(
    inputs.map((p) => [
      p,
      createHash("sha256").update(fs.readFileSync(p)).digest("hex"),
    ]),
  );
const result = {
  engine,
  label,
  at: new Date().toISOString(),
  scope:
    "Actual full App/StrictMode and actual PDF Worker/browser image decoder; controlled IPC/settings, no Tauri native or real Agent",
  before: hashes(),
  cases: [],
};
const browser = await (engine === "webkit" ? webkit : chromium).launch({
  headless: true,
  executablePath:
    engine === "webkit"
      ? path.resolve(
          "output/2026-10-10-text-feedback-webkit/browsers/webkit-2336/pw_run.sh",
        )
      : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const allScenarios = [
  { file: "crop-rotations-unit1.pdf", dpr: 1, rotations: [0, 90, 180, 270] },
  { file: "crop-rotations-unit2.pdf", dpr: 2, rotations: [0, 90, 180, 270] },
  ...Array.from({ length: 8 }, (_, i) => ({
    file: `asymmetric-exif-${i + 1}.jpg`,
    dpr: i % 2 ? 2 : 1,
    tag: i + 1,
  })),
  ...["asymmetric.png", "asymmetric-static.gif", "asymmetric-static.webp"].map(
    (file) => ({ file, dpr: 1, tag: 1 }),
  ),
];
const scenarios =
  process.argv[4] === "--smoke"
    ? [{ ...allScenarios[0], rotations: [0] }]
    : allScenarios;
try {
  for (const scenario of scenarios) {
    const c = {
      ...scenario,
      checks: [],
      errors: [],
      blocked: [],
      observations: [],
    };
    result.cases.push(c);
    const context = await browser.newContext({
      viewport: { width: 1280, height: 820 },
      deviceScaleFactor: scenario.dpr,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on("pageerror", (e) => c.errors.push(String(e)));
    await page.route("**/*", (route) =>
      route.request().url().startsWith("http://127.0.0.1:1468/")
        ? route.continue()
        : (c.blocked.push(route.request().url()), route.abort()),
    );
    const check = (name, pass, detail) => {
      c.checks.push({ name, pass, detail });
      if (!pass) throw new Error(name);
    };
    try {
      await page.goto(
        `http://127.0.0.1:1468/${base}/index.html?fixture=${scenario.file}&length=640`,
        { waitUntil: "networkidle" },
      );
      await page
        .getByText("CONTROLLED_VISUAL_AREA", { exact: true })
        .first()
        .click();
      await page.getByRole("button", { name: "视觉样本", exact: true }).click();
      const media = page.locator(
        scenario.rotations
          ? ".visual-area-stage canvas"
          : ".visual-area-stage img",
      );
      await page
        .getByRole("button", { name: "选择意见区域", exact: true })
        .waitFor();
      const actualDpr = await page.evaluate(() => window.devicePixelRatio);
      check("actual DPR matches requested", actualDpr === scenario.dpr, {
        actualDpr,
        requested: scenario.dpr,
      });
      const count = scenario.rotations?.length ?? 1;
      for (let index = 0; index < count; index++) {
        if (index > 0) {
          await page
            .getByRole("button", { name: "下一页", exact: true })
            .click();
          await page
            .getByRole("button", { name: "选择意见区域", exact: true })
            .waitFor();
        }
        const expected = scenario.rotations
          ? oracle.pdf.expectedByRotation[String(scenario.rotations[index])]
          : oracle.image.expectedByExifTag[String(scenario.tag)];
        await page
          .getByRole("button", { name: "选择意见区域", exact: true })
          .click();
        await media.scrollIntoViewIfNeeded();
        const scroll = await media.evaluate((e, rect) => {
          const r = e.getBoundingClientRect();
          const view = e
            .closest(".visual-file-preview")
            .getBoundingClientRect();
          return {
            x: view.left + view.width / 2,
            y: view.top + view.height / 2,
            delta:
              r.top +
              ((rect[1] + rect[3]) / 2e6) * r.height -
              (view.top + view.height / 2),
          };
        }, expected);
        await page.mouse.move(scroll.x, scroll.y);
        await page.mouse.wheel(0, scroll.delta);
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        const geometry = await media.evaluate((e, rect) => {
          const r = e.getBoundingClientRect();
          const canvas =
            e instanceof HTMLCanvasElement
              ? e
              : document.createElement("canvas");
          if (e instanceof HTMLImageElement) {
            canvas.width = e.naturalWidth;
            canvas.height = e.naturalHeight;
            canvas.getContext("2d").drawImage(e, 0, 0);
          }
          const cx = Math.floor(((rect[0] + rect[2]) / 2e6) * canvas.width),
            cy = Math.floor(((rect[1] + rect[3]) / 2e6) * canvas.height);
          const color = [
            ...canvas.getContext("2d").getImageData(cx, cy, 1, 1).data,
          ];
          return {
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height,
            pixelWidth: canvas.width,
            pixelHeight: canvas.height,
            markerCenterColor: color,
            stage: e.parentElement.getBoundingClientRect().toJSON(),
          };
        }, expected);
        c.observations.push({ index, geometry, expected });
        const [red, green, blue] = geometry.markerCenterColor;
        check(
          `page/image ${index + 1} actual decoded marker at literal location`,
          red > 150 && green < 60 && blue > 140,
          geometry.markerCenterColor,
        );
        check(
          `page/image ${index + 1} stage fits displayed pixels`,
          Math.abs(geometry.stage.width - geometry.width) < 0.01 &&
            Math.abs(geometry.stage.height - geometry.height) < 0.01,
          geometry,
        );
        const x1 = geometry.left + (expected[0] / 1e6) * geometry.width,
          y1 = geometry.top + (expected[1] / 1e6) * geometry.height,
          x2 = geometry.left + (expected[2] / 1e6) * geometry.width,
          y2 = geometry.top + (expected[3] / 1e6) * geometry.height;
        const hits = await page.evaluate(
          ([a, b]) =>
            [a, b].map(([x, y]) => {
              const e = document.elementFromPoint(x, y);
              return {
                x,
                y,
                tag: e?.tagName,
                stage: Boolean(e?.closest(".visual-area-stage")),
              };
            }),
          [
            [x1, y1],
            [x2, y2],
          ],
        );
        check(
          `page/image ${index + 1} pointer endpoints hit actual stage`,
          hits.every((h) => h.stage),
          hits,
        );
        // Real mouse transport: no synthetic PointerEvent, no factory injection.
        await page.mouse.move(x1, y1);
        await page.mouse.down();
        await page.mouse.move(x2, y2, { steps: 4 });
        await page.mouse.up();
        await page
          .getByRole("button", { name: "对此区域提意见", exact: true })
          .waitFor();
        await page
          .getByRole("button", { name: "对此区域提意见", exact: true })
          .click();
        const feedback = await page.evaluate(() =>
          Object.values(window.fixture.feedback()).at(-1),
        );
        const actual = feedback?.anchor;
        const pixelTolerance =
          Math.ceil(1e6 / Math.min(geometry.width, geometry.height)) + 1;
        check(
          `page/image ${index + 1} stored display box matches literal within one CSS-pixel input transport`,
          Boolean(actual) &&
            ["left", "top", "right", "bottom"].every(
              (k, i) => Math.abs(actual[k] - expected[i]) <= pixelTolerance,
            ),
          {
            actual,
            expected,
            pixelTolerance,
            events: await page.evaluate(() =>
              window.fixture.events
                .filter((e) => e.t.startsWith("pointer"))
                .slice(-4),
            ),
          },
        );
        check(
          `page/image ${index + 1} kind/page/version ownership`,
          actual?.space === "display-oriented-v1" &&
            (scenario.rotations
              ? actual.kind === "pdf-area" &&
                actual.page === index + 1 &&
                actual.pageCount === 4
              : actual.kind === "image-area") &&
            feedback.contentId.includes(
              (await page.evaluate(() => window.fixture.currentFile())).sha256,
            ),
          feedback,
        );
        await page
          .getByLabel("补充给 Agent 的意见", { exact: true })
          .fill(`Controlled area ${index + 1}`);
        if (index === 1 || (!scenario.rotations && scenario.tag === 7)) {
          const shot = `${base}/${engine}-${label}-${scenario.file}-${index + 1}.png`;
          await page.screenshot({ path: shot });
          c.screenshot = shot;
        }
        await page
          .getByRole("button", { name: "取消选择", exact: true })
          .click();
      }
      const metrics = await page.evaluate(() => window.fixture.metrics());
      c.metrics = metrics;
      check(
        "full App root remains bounded",
        metrics.windowY === 0 &&
          metrics.elements[".app"].y === 0 &&
          metrics.elements.html.scrollHeight <= 820,
        metrics,
      );
      check(
        "no unexpected or Agent IPC",
        await page.evaluate(
          () =>
            window.unexpected.length === 0 &&
            !window.calls.some((x) =>
              [
                "session_prompt",
                "session_send",
                "file_delivery_open",
                "file_delivery_reveal",
              ].includes(x.cmd),
            ),
        ),
        await page.evaluate(() => window.unexpected),
      );
      check(
        "no page errors or external request",
        c.errors.length === 0 && c.blocked.length === 0,
        { errors: c.errors, blocked: c.blocked },
      );
    } catch (error) {
      c.failure = String(error);
      c.body = await page.locator("body").innerText();
      c.calls = await page.evaluate(() => window.calls);
      c.metrics = await page.evaluate(() => window.fixture?.metrics());
      c.screenshot = `${base}/${engine}-${label}-${scenario.file}-failure.png`;
      await page.screenshot({ path: c.screenshot });
    } finally {
      await context.close();
    }
    if (c.failure) break;
  }
} finally {
  await browser.close();
  result.after = hashes();
  result.sourceUnchanged =
    JSON.stringify(result.before) === JSON.stringify(result.after);
  result.passed =
    result.sourceUnchanged && result.cases.every((c) => !c.failure);
  const raw = JSON.stringify(result, null, 2) + "\n";
  fs.writeFileSync(`${base}/${engine}-${label}.raw.txt`, raw);
  fs.writeFileSync(`${base}/${engine}-${label}.json`, raw);
  console.log(
    JSON.stringify({
      passed: result.passed,
      sourceUnchanged: result.sourceUnchanged,
      cases: result.cases.map((c) => ({
        file: c.file,
        checks: c.checks.length,
        failure: c.failure,
      })),
    }),
  );
  process.exitCode = result.passed ? 0 : 1;
}
