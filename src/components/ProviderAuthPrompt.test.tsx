import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ProviderAuthPrompt } from "./ProviderAuthPrompt";
it("shared secret and manual-code prompts are masked and never prefilled", () => {
  for (const type of ["secret", "manual_code"] as const) {
    const html = renderToStaticMarkup(
      <ProviderAuthPrompt
        prompt={{ id: "prompt", value: { type, message: "Credential" } }}
        onReply={() => {}}
      />,
    );
    expect(html).toContain('type="password"');
    expect(html).toContain('value=""');
    expect(html).toContain('autoComplete="off"');
  }
});
it("disabled selects preserve native option identities and labels", () => {
  const html = renderToStaticMarkup(
    <ProviderAuthPrompt
      disabled
      prompt={{
        id: "prompt",
        value: {
          type: "select",
          message: "Choose",
          options: [{ id: "native-id", label: "Native choice" }],
        },
      }}
      onReply={() => {}}
    />,
  );
  expect(html).toContain("Native choice");
  expect(html).toContain('disabled=""');
});
