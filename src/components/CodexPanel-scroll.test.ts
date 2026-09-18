import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";

// The follow-scroll effect must observe ACP transcript updates so new native
// entries scroll into view; this was a reproduced regression in the retired
// workspace and the dependency must survive the panel migration.
it("the following effect observes ACP transcript updates", () => {
  const source = ts.createSourceFile(
    "panel.tsx",
    readFileSync(new URL("./CodexPanel.tsx", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const effects: ts.CallExpression[] = [];
  function visit(n: ts.Node) {
    if (
      ts.isCallExpression(n) &&
      n.expression.getText(source) === "useLayoutEffect" &&
      n.arguments[0]?.getText(source).includes("scrollHeight")
    )
      effects.push(n);
    ts.forEachChild(n, visit);
  }
  visit(source);
  expect(effects).toHaveLength(1);
  expect(effects[0].arguments[0].getText(source)).toContain(
    "following.current",
  );
  expect(effects[0].arguments[1].getText(source)).toContain("acp?.transcript");
});
