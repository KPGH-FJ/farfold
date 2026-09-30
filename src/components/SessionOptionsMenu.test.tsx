import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionOptionsList } from "./SessionOptionsMenu";
import { freshThreadState, type ConfigOptionView } from "../runtime/sessions";

const mode: ConfigOptionView = {
  id: "work-mode",
  name: "Session Mode",
  category: "mode",
  type: "select",
  currentValue: "build",
  options: [{ value: "build", name: "Build" }],
};
function render(option: ConfigOptionView) {
  const thread = freshThreadState(
    "fixture:/p:options",
    "fixture",
    "/p",
    "options",
  );
  thread.identity = "established";
  thread.configOptions = [option];
  return renderToStaticMarkup(<SessionOptionsList thread={thread} />);
}
it("uses the common mode category label without translating official values", () => {
  const html = render(mode);
  expect(html).toContain("工作模式");
  expect(html).not.toContain("Session Mode");
  expect(html).toContain("Build");
});
it("recognizes the exact legacy mode id only when no category was declared", () => {
  expect(render({ ...mode, id: "mode", category: undefined })).toContain(
    "工作模式",
  );
  const html = render({
    ...mode,
    id: "mode",
    category: "vendor_feature",
    name: "Vendor decision profile",
  });
  expect(html).toContain("Vendor decision profile");
  expect(html).not.toContain("工作模式");
});
