import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";

// The follow-scroll effect must observe both Direct conversation updates and
// ACP transcript updates; this was a reproduced regression before the pause.
it(
  "the following effect observes both Direct and ACP transcript updates",
  () => {
    const source = ts.createSourceFile(
      "workspace.tsx",
      readFileSync(new URL("./CodexWorkspace.tsx", import.meta.url), "utf8"),
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
    expect(effects[0].arguments[1].getText(source)).toContain("conversation");
    expect(effects[0].arguments[1].getText(source)).toContain(
      "acp?.transcript",
    );
  },
);
