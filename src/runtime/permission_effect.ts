import type { ThreadState } from "./session_types";

/** Local access-layer facts, not an Agent permission/profile or approval. */
export interface PermissionEffect {
  configId: string;
  appliesAt: "next_ordinary_prompt";
  currentScope: "unknown";
}
export function readPermissionEffect(
  value: unknown,
  configId?: string,
): PermissionEffect | undefined {
  if (!configId || !value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const fields = value as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (
    keys.length !== 3 ||
    !["configId", "appliesAt", "currentScope"].every((key) =>
      Object.hasOwn(fields, key),
    ) ||
    fields.configId !== configId ||
    fields.appliesAt !== "next_ordinary_prompt" ||
    fields.currentScope !== "unknown"
  )
    return undefined;
  return {
    configId,
    appliesAt: "next_ordinary_prompt",
    currentScope: "unknown",
  };
}
export function replacePermissionEffect(
  thread: ThreadState,
  value: unknown,
): void {
  thread.permissionEffect = readPermissionEffect(
    value,
    thread.permissionConfigId,
  );
}
export function hasNextOrdinaryPermissionEffect(thread: ThreadState): boolean {
  return (
    readPermissionEffect(thread.permissionEffect, thread.permissionConfigId) !==
    undefined
  );
}
