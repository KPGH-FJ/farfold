import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { modelConfigOption } from "./session_projection";
import { freshThreadState, type ConfigOptionView } from "./sessions";
import { protectedConfigIds } from "./protected_config";
import { SessionOptionsList } from "../components/SessionOptionsMenu";
import { ModelPicker } from "../components/ModelPicker";

function option(id: string, name: string, currentValue = id): ConfigOptionView {
  return {
    id,
    name,
    category: "model",
    type: "select",
    currentValue,
    options: [{ value: currentValue, name: currentValue }],
  };
}

// Official interface shape: provider precedes model and both share a category.
const provider = option("provider", "Provider", "Cline Usage-Billing");
const model = option("model", "Model", "stealth/space-bunny-alpha");

it.each([
  [provider, model],
  [model, provider],
])(
  "keeps the concrete model independent of category order: %j",
  (...options) => {
    expect(modelConfigOption(options)).toBe(model);
    const state = freshThreadState(
      "model-selection",
      "example",
      "/fixture",
      "draft",
    );
    state.configOptions = options;
    const remaining = renderToStaticMarkup(
      <SessionOptionsList thread={state} />,
    );
    expect(remaining).toContain("Provider");
    expect(remaining).not.toContain("stealth/space-bunny-alpha");
    expect([...protectedConfigIds(options)].sort()).toEqual([
      "model",
      "provider",
    ]);
    const html = renderToStaticMarkup(
      <ModelPicker
        option={modelConfigOption(options)}
        onPick={() => undefined}
      />,
    );
    expect(html).toContain("stealth/space-bunny-alpha");
    expect(html).not.toContain("Cline Usage-Billing");
  },
);

it("prefers the unique model ID before an unrelated option's display name", () => {
  expect(modelConfigOption([option("provider", "Model"), model])).toBe(model);
});

it("accepts a unique exact model name for opaque IDs", () => {
  const opaque = option("vendor-llm", "MODEL");
  expect(modelConfigOption([provider, opaque])).toBe(opaque);
});

it("preserves a single declared model with an arbitrary ID and name", () => {
  const opaque = option("vendor-choice", "Engine");
  expect(modelConfigOption([opaque, { ...model, category: undefined }])).toBe(
    opaque,
  );
});

it.each([
  [option("first", "First"), option("second", "Second")],
  [model, option("MODEL", "Other")],
  [option("first", "Model"), option("second", "MODEL")],
])(
  "keeps ambiguous model-category controls reachable without guessing a primary",
  (...options) => {
    expect(
      modelConfigOption([...options, { ...model, category: undefined }]),
    ).toBeNull();
    const state = freshThreadState(
      "ambiguous-model",
      "example",
      "/fixture",
      "draft",
    );
    state.configOptions = options;
    const remaining = renderToStaticMarkup(
      <SessionOptionsList thread={state} />,
    );
    for (const item of options) expect(remaining).toContain(item.name);
  },
);

it("retains the existing category-less select compatibility", () => {
  const legacy = { ...model, id: "model_selection", category: undefined };
  expect(modelConfigOption([legacy])).toBe(legacy);
});
