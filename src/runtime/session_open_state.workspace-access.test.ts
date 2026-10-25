import { expect, it } from "vitest";
import { openedThreadState } from "./session_open_state";

const input = { agentId: "fixture", cwd: "/owned" };
const result = {
  nativeSessionId: "owned-native",
  connectionId: "owned-connection",
  cwd: "/owned",
  configOptions: [],
  resumed: false,
  warnings: [],
};
const access = (value: object) =>
  (value as { workspaceAccess?: unknown }).workspaceAccess ?? null;

it("retains the reviewed read-only capability on a real prepared draft", () => {
  const capability = {
    statusQuery: true as const,
    provenance: "reviewed-official-supplement" as const,
  };
  const state = openedThreadState(
    input,
    { ...result, workspaceAccess: capability },
    null,
  );
  expect(state.identity).toBe("draft");
  expect(access(state)).toEqual(capability);
});

it("does not infer the capability from missing or unrelated opening metadata", () => {
  expect(access(openedThreadState(input, result, null))).toBeNull();
  expect(
    access(
      openedThreadState(
        input,
        { ...result, meta: { trust: true }, configOptions: [] },
        null,
      ),
    ),
  ).toBeNull();
});
