import { expect, it } from "vitest";
import {
  hasNextOrdinaryPermissionEffect,
  readPermissionEffect,
  replacePermissionEffect,
} from "./permission_effect";
import { freshThreadState } from "./session_projection";

const fact = {
  configId: "permission",
  appliesAt: "next_ordinary_prompt",
  currentScope: "unknown",
};

it("copies only the exact access-layer fact matching this owner's actual option", () => {
  const received = { ...fact };
  const parsed = readPermissionEffect(received, "permission");
  expect(parsed).toEqual(fact);
  expect(parsed).not.toBe(received);
  received.currentScope = "forged";
  expect(parsed?.currentScope).toBe("unknown");
  expect(readPermissionEffect(fact, "another-option")).toBeUndefined();
  expect(readPermissionEffect(fact)).toBeUndefined();
});

it.each([
  undefined,
  null,
  [],
  "next_ordinary_prompt",
  {},
  { ...fact, appliesAt: "now" },
  { ...fact, currentScope: "verified" },
  { ...fact, currentScope: { files: "all", network: true } },
  { ...fact, profile: "read-only" },
  { configId: "permission", appliesAt: "next_ordinary_prompt" },
  Object.create(fact),
])(
  "does not infer scope or timing from malformed/absent facts %#",
  (received) => {
    expect(readPermissionEffect(received, "permission")).toBeUndefined();
  },
);

it("retires previous timing on absent/invalid input and never transfers it to a fresh owner", () => {
  const old = freshThreadState("same-key", "chosen", "/owned", "same-id");
  old.permissionConfigId = "permission";
  replacePermissionEffect(old, fact);
  expect(hasNextOrdinaryPermissionEffect(old)).toBe(true);
  const replacement = freshThreadState(
    old.key,
    old.agentId,
    old.cwd,
    old.nativeSessionId,
  );
  replacement.permissionConfigId = "permission";
  expect(hasNextOrdinaryPermissionEffect(replacement)).toBe(false);
  replacePermissionEffect(old, undefined);
  expect(old.permissionEffect).toBeUndefined();
  replacePermissionEffect(old, { ...fact, currentScope: "verified" });
  expect(hasNextOrdinaryPermissionEffect(old)).toBe(false);
});
