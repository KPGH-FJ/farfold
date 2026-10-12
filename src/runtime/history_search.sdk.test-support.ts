/** Controlled DTOs only; actual Rust serde evidence is tested separately. */
import { operation, selection } from "./history_search.test-support";
import type { HistorySearchOperation } from "./history_search_types";

export const sdkScope = {
  source: "officialSdk",
  coverage: "partial",
  relation: "registeredExactId",
  continuation: "unverified",
  branch: "unverified",
} as const;

export function sdkSelection() {
  return { ...selection(), ...sdkScope };
}

export function sdkOperation(
  state: HistorySearchOperation["state"] = "completed",
  revision = 3,
) {
  const old = operation(state, revision).operation;
  return {
    kind: "operation" as const,
    operation: {
      ...old,
      ...sdkScope,
      rows: old.rows.map((row) => ({
        ...row,
        state: state === "completed" ? "partial" : row.state,
        code: state === "completed" ? "coverageUnconfirmed" : row.code,
      })),
      hits: old.hits.map(
        ({ turnId: _turn, itemId: _item, partIndex, ...hit }) => ({
          ...hit,
          messageLocator: {
            kind: "message" as const,
            messageId: "00000000-0000-4000-8000-000000000010",
            partIndex,
          },
        }),
      ),
    },
  };
}
