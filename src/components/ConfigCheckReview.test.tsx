import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfigCheckReview } from "./ConfigCheckReview";
import type { ConfigCheck } from "../runtime/config_check";

it("retains legacy confirmation choices and their actual values without interpreting extra payload", () => {
  const current = {
    model: { id: "old-model", category: "model", value: "original-model" },
    thoughtLevel: {
      id: "old-effort",
      category: "thought_level",
      value: "original-effort",
    },
    extra: { privatePayload: "not-choice-canary" },
  };
  const check: ConfigCheck = {
    status: "confirmation_required",
    issues: [],
    current,
  };
  const html = renderToStaticMarkup(
    <ConfigCheckReview check={check} options={[]} />,
  );
  expect(html).toContain("old-model");
  expect(html).toContain("original-model");
  expect(html).toContain("old-effort");
  expect(html).toContain("original-effort");
  expect(html).not.toContain("not-choice-canary");
  expect(check.current).toBe(current);
});

it("does not guess confirmation choices from unrelated legacy maps or malformed records", () => {
  for (const current of [
    { model: "flat" },
    {
      choices: [
        { id: "model", value: "bad", type: "unknown" },
        { id: "effort", type: "select", value: { raw: "not-public-choice" } },
      ],
    },
  ]) {
    const check: ConfigCheck = {
      status: "confirmation_required",
      issues: [],
      current,
    };
    expect(
      renderToStaticMarkup(<ConfigCheckReview check={check} options={[]} />),
    ).toBe("");
  }
});
