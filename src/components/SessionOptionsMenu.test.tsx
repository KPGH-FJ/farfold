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

it.each(["Mode", "Session Mode", " mode ", " sEsSiOn MoDe "])(
  "localizes only the exact standard operating description for %j",
  (name) => {
    const option = {
      ...mode,
      name,
      description: "Session operating mode",
    };
    const before = structuredClone(option);
    const html = render(option);
    expect(html).toContain("对话的工作方式。");
    expect(html).not.toContain("Session operating mode");
    expect(option).toEqual(before);
  },
);

it.each([
  " Session operating mode",
  "Session operating mode ",
  "session operating mode",
  "Session operating mode.",
  "Session operating mode: experimental",
])("preserves an unknown mode description exactly: %j", (description) => {
  const html = render({ ...mode, description });
  expect(html).toContain(description);
  expect(html).not.toContain("对话的工作方式。");
});

it.each(["Planning strategy", "Auto Approve", "YOLO", "Mode preview"])(
  "does not infer description semantics from category or id for %j",
  (name) => {
    const html = render({
      ...mode,
      id: "mode",
      name,
      description: "Session operating mode",
    });
    expect(html).toContain(name);
    expect(html).toContain("Session operating mode");
    expect(html).not.toContain("对话的工作方式。");
  },
);

it.each([undefined, ""])(
  "keeps the existing missing-description fallback for %j",
  (description) => {
    const html = render({ ...mode, description });
    expect(html).toContain("Agent 未提供说明。");
    expect(html).not.toContain("对话的工作方式。");
  },
);

it("preserves boolean and unknown descriptions, values and order beside the standard mode", () => {
  const options: ConfigOptionView[] = [
    { ...mode, description: "Session operating mode" },
    {
      id: "autoApprove",
      name: "Auto Approve",
      category: "mode",
      type: "boolean",
      currentValue: false,
      description: "Automatically approve actions when YOLO is disabled",
      options: [],
    },
    {
      id: "yolo",
      name: "YOLO",
      category: "mode",
      type: "boolean",
      currentValue: true,
      description: "Bypass approval and safety prompts",
      options: [],
    },
    {
      id: "future",
      name: "Decision strategy",
      category: "mode",
      type: "future",
      currentValue: "opaque",
      description: "Vendor supplied description",
      options: [],
    },
  ];
  const before = structuredClone(options);
  const html = render(options);
  expect(html).toContain("对话的工作方式。");
  expect(html).toContain('aria-label="Auto Approve" aria-checked="false"');
  expect(html).toContain('aria-label="YOLO" aria-checked="true"');
  const descriptions = [
    "对话的工作方式。",
    ...options.slice(1).map(({ description }) => description!),
  ];
  const positions = descriptions.map((value) => html.indexOf(value));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(options).toEqual(before);
});
