import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AgentSelectionReview,
  selectionReviewRows,
} from "./AgentSelectionReview";
import type { Credential } from "../runtime/credentials";
import { AGENT_REDESIGN as U } from "../runtime/agent_redesign_strings";
import { STRINGS } from "../runtime/strings";

it("labels boolean values and retains an older string value for explicit comparison", () => {
  const rows = selectionReviewRows(
    { service: null, config: { toggle: "off" } },
    { service: null, config: { toggle: false } },
    [],
    [
      {
        id: "toggle",
        name: "Toggle",
        type: "boolean",
        currentValue: false,
        options: [],
      },
    ],
  );
  expect(rows[1]).toEqual({
    name: "Toggle",
    before: "off",
    after: STRINGS.options.disabled,
  });
});

it("keeps a removed or changed service unknown rather than describing the new revision as the previous source", () => {
  const previous = {
    service: { id: "s", revision: "one", model: "old-model" },
    config: { mode: "one" },
  };
  const next = {
    service: { id: "s", revision: "two", model: "new-model" },
    config: { mode: "two" },
  };
  const records = [
    {
      id: "s",
      revision: "two",
      label: "New service",
      endpoint: "https://new.example",
    },
  ] as Credential[];
  const rows = selectionReviewRows(previous, next, records, [
    {
      id: "mode",
      name: "Work mode",
      type: "select",
      currentValue: "two",
      options: [
        { name: "One", value: "one" },
        { name: "Two", value: "two" },
      ],
    },
  ]);
  expect(rows[0].before).toBe(U.selectedSource);
  expect(rows[0].after).toBe("New service · https://new.example");
  expect(rows[1]).toEqual({
    name: U.model,
    before: "old-model",
    after: "new-model",
  });
  expect(rows[2]).toEqual({ name: "Work mode", before: "One", after: "Two" });
  expect(previous.service.revision).toBe("one");
});

it("shows configuration differences without exposing structured payloads and leaves equal selections quiet", () => {
  const before = { service: null, config: { hidden: { secret: "internal" } } };
  const after = { service: null, config: { hidden: { secret: "different" } } };
  const html = renderToStaticMarkup(
    <AgentSelectionReview
      before={before}
      after={after}
      services={[]}
      options={[]}
    />,
  );
  expect(html).toContain(U.notProvided);
  expect(html).not.toContain("internal");
  expect(html).not.toContain("different");
  expect(
    renderToStaticMarkup(
      <AgentSelectionReview
        before={before}
        after={before}
        services={[]}
        options={[]}
      />,
    ),
  ).toBe("");
});
