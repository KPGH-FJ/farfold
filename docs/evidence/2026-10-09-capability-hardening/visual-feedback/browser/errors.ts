import { renderPdfPage } from "/src/runtime/pdf_preview";
import { VISUAL_PREVIEW_STRINGS as S } from "/src/runtime/visual_preview";
const results: any[] = [];
const canvas = document.querySelector("canvas")!;
const check = (name: string, ok: boolean, detail?: unknown) => {
  results.push({ name, ok, detail });
  if (!ok) throw new Error(name);
};
const data = async (name: string) =>
  new Uint8Array(
    await (
      await fetch("/src/runtime/fixtures/pdf-preview/" + name)
    ).arrayBuffer(),
  );
async function run() {
  for (const [name, expected] of [
    ["damaged.pdf", S.failed],
    ["password.pdf", S.password],
    ["unembedded-chinese.pdf", S.failed],
  ]) {
    let message = "",
      reported = 0;
    const start = performance.now();
    try {
      await renderPdfPage(
        await data(name),
        canvas,
        1,
        600,
        new AbortController().signal,
        () => reported++,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    check(
      name + " reports exact fixed failure without page eligibility",
      message === expected && reported === 0 && canvas.width === 0,
      { message, reported, ms: performance.now() - start },
    );
  }
  const controller = new AbortController();
  let reported = 0;
  const promise = renderPdfPage(
    await data("mixed-two-pages.pdf"),
    canvas,
    1,
    600,
    controller.signal,
    () => reported++,
  );
  controller.abort();
  let message = "";
  try {
    await promise;
  } catch (error) {
    message = (error as Error).message;
  }
  await new Promise((r) => setTimeout(r, 100));
  check(
    "cancelled real worker cannot publish a late page",
    message === S.cancelled && reported === 0 && canvas.width === 0,
    { message, reported },
  );
  await renderPdfPage(
    await data("mixed-two-pages.pdf"),
    canvas,
    2,
    600,
    new AbortController().signal,
    (total) => (reported = total),
  );
  check(
    "next owned worker still renders page two after failures and cancellation",
    reported === 2 && canvas.width === 600,
    { width: canvas.width, height: canvas.height },
  );
  document.querySelector("#result")!.textContent = JSON.stringify(
    { passed: true, results },
    null,
    2,
  );
  document.documentElement.dataset.done = "true";
}
run().catch((error) => {
  document.querySelector("#result")!.textContent = JSON.stringify(
    { passed: false, results, error: String(error) },
    null,
    2,
  );
  document.documentElement.dataset.done = "true";
});
