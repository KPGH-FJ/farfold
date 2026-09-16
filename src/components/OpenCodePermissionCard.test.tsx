import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OpenCodePermissionCard } from "./OpenCodePermissionCard";

describe("OpenCode native question form", () => {
  it("renders every question with native selection types and custom entry", () => {
    const html = renderToStaticMarkup(
      <OpenCodePermissionCard
        request={{
          id: "question-1",
          sessionId: "session-1",
          requestKind: "question",
          permission: "First",
          patterns: [],
          always: [],
          metadata: {},
          questionFields: [
            {
              id: "choice",
              title: "First",
              multiple: false,
              customField: "choice_other",
              options: [{ label: "A", description: "Alpha" }],
            },
            {
              id: "choice1",
              title: "Second",
              multiple: true,
              customField: null,
              options: [
                { label: "B", description: "Beta" },
                { label: "C", description: "Gamma" },
              ],
            },
          ],
        }}
        busy={false}
        onRespond={() => {}}
      />,
    );
    expect(html).toContain("First");
    expect(html).toContain("Second");
    expect(html).toContain('type="radio"');
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toContain("Alpha");
    expect(html).toContain("其他回答");
    expect(html).toMatch(/type="submit"[^>]*disabled/);
  });
});
