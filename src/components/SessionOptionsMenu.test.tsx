import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionOptionsList } from "./SessionOptionsMenu";
import { freshThreadState, type ConfigOptionView } from "../runtime/sessions";
import { synthesizeModeOption } from "../runtime/session_projection";

const mode: ConfigOptionView = {
  id: "work-mode",
  name: "Session Mode",
  category: "mode",
  type: "select",
  currentValue: "build",
  options: [{ value: "build", name: "Build" }],
};
function render(options: ConfigOptionView | ConfigOptionView[]) {
  const thread = freshThreadState(
    "fixture:/p:options",
    "fixture",
    "/p",
    "options",
  );
  thread.identity = "established";
  thread.configOptions = Array.isArray(options) ? options : [options];
  return renderToStaticMarkup(<SessionOptionsList thread={thread} />);
}
it.each([
  { name: "Session Mode", category: "mode" },
  { name: "Mode", category: "mode" },
  { name: " mode ", category: "vendor_feature" },
  { name: " sEsSiOn MoDe ", category: undefined },
])("uses the common title for the exact known name $name", (declaration) => {
  const html = render({ ...mode, ...declaration });
  expect(html).toContain("工作模式");
  expect(html).not.toContain(declaration.name);
  expect(html).toContain("Build");
});
it("does not infer a translated label from an official option id", () => {
  const planning = render({
    ...mode,
    id: "mode",
    category: undefined,
    name: "Planning strategy",
  });
  expect(planning).toContain("Planning strategy");
  expect(planning).not.toContain("工作模式");
  const html = render({
    ...mode,
    id: "mode",
    category: "vendor_feature",
    name: "Vendor decision profile",
  });
  expect(html).toContain("Vendor decision profile");
  expect(html).not.toContain("工作模式");
});

it("keeps a synthesized legacy mode's existing local title", () => {
  const legacy = synthesizeModeOption({
    currentModeId: "build",
    availableModes: [{ id: "build", name: "Build" }],
  });
  expect(legacy).not.toBeNull();
  const html = render(legacy!);
  expect(html).toContain("工作模式");
  expect(html).toContain("Build");
});

it("preserves repeated mode titles, types, values and order without guessing a primary control", () => {
  const options: ConfigOptionView[] = [
    { ...mode, id: "mode", name: "Mode" },
    {
      id: "autoApprove",
      name: "Auto Approve",
      category: "mode",
      type: "boolean",
      currentValue: false,
      options: [],
    },
    {
      id: "yolo",
      name: "YOLO",
      category: "mode",
      type: "boolean",
      currentValue: true,
      options: [],
    },
    { ...mode, id: "other-mode", name: "Other mode" },
    {
      id: "future-mode",
      name: "Future mode control",
      category: "mode",
      type: "future",
      currentValue: "opaque",
      options: [],
    },
  ];
  const before = structuredClone(options);
  const html = render(options);
  expect(html).toContain('aria-label="Auto Approve" aria-checked="false"');
  expect(html).toContain('aria-label="YOLO" aria-checked="true"');
  expect(html).toContain("Future mode control");
  expect(html).toContain("opaque");
  expect(html.match(/class="so-name">工作模式</g)).toHaveLength(1);
  const displayedNames = [
    "工作模式",
    ...options.slice(1).map(({ name }) => name),
  ];
  const titles = displayedNames.map((name) => html.indexOf(`>${name}<`));
  expect(titles.every((position) => position >= 0)).toBe(true);
  expect(titles).toEqual([...titles].sort((a, b) => a - b));
  expect(options).toEqual(before);
});

it("preserves official boolean and unknown options even with the exact mode id", () => {
  const boolean = render({
    ...mode,
    id: "mode",
    name: "Permission control",
    type: "boolean",
    currentValue: false,
    options: [],
  });
  expect(boolean).toContain('aria-label="Permission control"');
  expect(boolean).not.toContain("工作模式");
  const unknown = render({
    ...mode,
    id: "mode",
    name: "Decision strategy",
    type: "future",
  });
  expect(unknown).toContain("Decision strategy");
  expect(unknown).not.toContain("工作模式");
});
