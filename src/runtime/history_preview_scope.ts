import type { AgentCardModel } from "./agents";
import type { DiscoveredConversation } from "./history_import";
import type { IndexRow } from "./sessions";

function facts(value: unknown): string {
  return (
    JSON.stringify(value, (_key, item: unknown) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.entries(item).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          )
        : item,
    ) ?? ""
  );
}

/** Public launch provenance only; a reported version is not a source change. */
export function historyPreviewAgentKey(
  agent: AgentCardModel | undefined,
): string {
  return facts([
    agent?.id,
    agent?.source,
    agent?.programPath,
    agent?.discoveredPath,
    agent?.custom,
  ]);
}

export function historyPreviewRowKey(row: DiscoveredConversation): string {
  return facts([
    row.nativeSessionId,
    row.cwd,
    row.canLoad,
    row.locationAvailable,
    row.alreadyAddedId,
    row.isOpen,
  ]);
}

/** Titles, clocks and unrelated conversations cannot change this association. */
export function historyPreviewAssociationKey(
  index: readonly IndexRow[],
  agentId: string,
  nativeSessionId: string,
): string {
  return facts(
    index
      .filter(
        (row) =>
          row.agentId === agentId && row.nativeSessionId === nativeSessionId,
      )
      .map((row) => [
        row.id,
        row.agentId,
        row.nativeSessionId,
        row.cwd,
        row.configOptions,
      ])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
  );
}
