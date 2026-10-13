import { expect, it } from "vitest";
import { tryAcquirePdfWorkerSlot as take } from "./pdf_worker_slots";

it("shares two trees across previews and inputs, allowing only one input and idempotent release", () => {
  const input = take("input")!,
    preview = take("preview")!;
  try {
    expect(take("input")).toBeNull();
    expect(take("preview")).toBeNull();
    preview();
    preview();
    expect(take("input")).toBeNull();
    const nextPreview = take("preview")!;
    expect(nextPreview).toBeTypeOf("function");
    nextPreview();
  } finally {
    input();
    preview();
  }
  const first = take("preview")!,
    second = take("preview")!;
  try {
    expect(take("input")).toBeNull();
  } finally {
    first();
    second();
  }
  const recovered = take("input")!;
  expect(recovered).toBeTypeOf("function");
  recovered();
});
