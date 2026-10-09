import { renderPdfPixels } from "/src/runtime/pdf_render_core";
function makePdf(changed = false) {
  const stream = (color: string) => `q ${color} rg 20 20 280 150 re f Q`;
  const first = stream(changed ? "0.7 0.2 0.5" : "0.15 0.35 0.65"),
    second = stream("0.2 0.55 0.25");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 200] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${first.length} >>\nstream\n${first}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 200] /Resources << >> /Contents 6 0 R >>",
    `<< /Length ${second.length} >>\nstream\n${second}\nendstream`,
  ];
  let value = "%PDF-1.7\n",
    offsets = [0];
  objects.forEach((s, i) => {
    offsets.push(value.length);
    value += `${i + 1} 0 obj\n${s}\nendobj\n`;
  });
  const xref = value.length;
  value +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
      .join("") +
    `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return value;
}
const events: any[] = [];
const worker = new Worker(
  new URL("/src/workers/pdf_preview.worker.ts", import.meta.url),
  { type: "module" },
);
worker.addEventListener("error", () => events.push({ kind: "error" }));
worker.addEventListener("message", (event) =>
  events.push({
    kind: "message",
    action: event.data?.action,
    keys: Object.keys(event.data ?? {}),
  }),
);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function run() {
  if (!new URL(location.href).searchParams.has("immediate"))
    for (let i = 0; i < 100 && !events.some((e) => e.action === "ready"); i++)
      await wait(50);
  const ready = events.some((e) => e.action === "ready");
  let result: any;
  try {
    const data = Uint8Array.from(makePdf(), (c) => c.charCodeAt(0));
    const rendered = await Promise.race([
      renderPdfPixels(data, 1, 600, worker, () => false),
      wait(8000).then(() => {
        throw new Error("bounded timeout");
      }),
    ]);
    result = {
      status: "success",
      pages: rendered.pages,
      width: rendered.bitmap.width,
      height: rendered.bitmap.height,
    };
    rendered.bitmap.close();
  } catch (error) {
    result = { status: "error", error: String(error) };
  }
  worker.terminate();
  document.querySelector("#result")!.textContent = JSON.stringify(
    { passed: result.status === "success", ready, events, result },
    null,
    2,
  );
  document.documentElement.dataset.done = "true";
}
run();
