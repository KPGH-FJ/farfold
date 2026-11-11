import { afterEach, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CustomAgentDialog } from "./CustomAgentDialog";
import { customAgentDraft } from "../runtime/custom_agent_draft";
import { CUSTOM_AGENT } from "../runtime/custom_agent_strings";
import type { AgentsState } from "../runtime/agents";

afterEach(() => customAgentDraft.clear());
it("renders distinct labelled ordinary and protected inputs with real React", () => {
  customAgentDraft.keep({
    name: "synthetic",
    command: "/synthetic/program",
    args: "",
    envText: "OPTION=ordinary",
    secretEntries: [{ name: "TOKEN", value: "" }],
  });
  const html = renderToStaticMarkup(
    <CustomAgentDialog
      agents={
        { errors: {}, addCustom: async () => null } as unknown as AgentsState
      }
      onClose={() => {}}
      onAdded={() => {}}
    />,
  );
  expect(html).toContain('type="password"');
  expect(html).toContain('autoComplete="new-password"');
  expect(html).toContain(CUSTOM_AGENT.secretName);
  expect(html).toContain(CUSTOM_AGENT.secretValue);
  expect(html).toContain(CUSTOM_AGENT.envHint);
  expect(html).toContain(CUSTOM_AGENT.secretHint);
  expect(html).toContain("OPTION=ordinary");
});
