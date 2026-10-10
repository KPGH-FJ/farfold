import { renderPdfPage } from "/src/runtime/pdf_preview";
import { validateDraftImage } from "/src/runtime/draft_images";
import captures from "./capture-data.json";
import oracle from "../../fixtures/oracle.json";
const surface = document.querySelector<HTMLElement>("#surface")!;
const checks: unknown[] = [];
const reports: unknown[] = [];
const check = (name: string, pass: boolean, details: unknown) => {
  checks.push({ name, pass, details });
  if (!pass) throw new Error(name);
};
(window as any).result = { done: false, checks, reports };
try {
  for (const name of [
    "crop-rotations-unit1.pdf",
    "crop-rotations-unit2.pdf",
  ] as const) {
    const capture = captures[name];
    for (let page = 1; page <= 4; page++) {
      const canvas = document.createElement("canvas");
      surface.replaceChildren(canvas);
      let ready: unknown;
      await renderPdfPage(
        Uint8Array.from(atob(capture.data), (c) => c.charCodeAt(0)),
        canvas,
        page,
        900,
        new AbortController().signal,
        (pages, actual = page) => {
          ready = { pages, actual };
        },
      );
      const angle = [0, 90, 180, 270][page - 1];
      const expected = (
        oracle.pdf.expectedByRotation as Record<string, number[]>
      )[String(angle)];
      const pixels = canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -1,
        y1 = -1;
      for (let y = 0; y < canvas.height; y++)
        for (let x = 0; x < canvas.width; x++) {
          const i = (y * canvas.width + x) * 4;
          if (pixels[i] > 150 && pixels[i + 1] < 60 && pixels[i + 2] > 140) {
            x0 = Math.min(x0, x);
            y0 = Math.min(y0, y);
            x1 = Math.max(x1, x + 1);
            y1 = Math.max(y1, y + 1);
          }
        }
      const wanted = expected.map(
        (v, i) => (v / 1e6) * (i % 2 ? canvas.height : canvas.width),
      );
      const actual = [x0, y0, x1, y1];
      const error = Math.max(...actual.map((v, i) => Math.abs(v - wanted[i])));
      check(
        name + " page" + page + " ready page identity",
        JSON.stringify(ready) === JSON.stringify({ pages: 4, actual: page }),
        ready,
      );
      check(
        name + " page" + page + " marker from independent literal",
        Number.isFinite(error) && error <= 1.01,
        { actual, wanted, error, size: [canvas.width, canvas.height] },
      );
      reports.push({
        file: name,
        page,
        angle,
        expected,
        actual,
        canvas: [canvas.width, canvas.height],
      });
    }
  }
  for (const name of Object.keys(captures).filter(
    (n) => !n.endsWith(".pdf"),
  ) as (keyof typeof captures)[]) {
    const capture = captures[name];
    const checked = await validateDraftImage(capture.data, capture.mimeType);
    const img = new Image();
    img.alt = name;
    img.src = `data:${checked.mimeType};base64,${checked.data}`;
    surface.replaceChildren(img);
    await img.decode();
    const tag = Number(name.match(/exif-(\d)/)?.[1] ?? 1);
    const expected = (
      oracle.image.expectedByExifTag as Record<string, number[]>
    )[String(tag)];
    const wantedSize = tag <= 4 ? [320, 200] : [200, 320];
    check(
      name + " actual oriented dimensions",
      img.naturalWidth === wantedSize[0] && img.naturalHeight === wantedSize[1],
      { actual: [img.naturalWidth, img.naturalHeight], wantedSize },
    );
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d")!.drawImage(img, 0, 0);
    const pixels = canvas
      .getContext("2d")!
      .getImageData(0, 0, canvas.width, canvas.height).data;
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -1,
      y1 = -1;
    for (let y = 0; y < canvas.height; y++)
      for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        if (pixels[i] > 150 && pixels[i + 1] < 60 && pixels[i + 2] > 140) {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x + 1);
          y1 = Math.max(y1, y + 1);
        }
      }
    const actual = [x0, y0, x1, y1],
      wanted = expected.map(
        (v, i) => (v / 1e6) * (i % 2 ? canvas.height : canvas.width),
      );
    const error = Math.max(...actual.map((v, i) => Math.abs(v - wanted[i])));
    check(
      name + " actual decoded marker",
      Number.isFinite(error) && error <= 1.01,
      { actual, wanted, error },
    );
    reports.push({
      file: name,
      tag,
      expected,
      actual,
      size: [canvas.width, canvas.height],
    });
  }
  (window as any).result = {
    done: true,
    passed: true,
    checks,
    reports,
    dpr: window.devicePixelRatio,
  };
} catch (error) {
  (window as any).result = {
    done: true,
    passed: false,
    error: String(error),
    checks,
    reports,
  };
}
