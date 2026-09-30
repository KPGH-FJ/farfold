import type { ServiceSelection } from "./credentials";

type Choice = {
  service: (ServiceSelection & { revision?: string }) | null;
  config: Record<string, unknown>;
};
const ordered = (value: Record<string, unknown>) =>
  JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));

/** Returning from preparation must not silently retarget existing input. */
export function replacesDraftChoice(
  current: Choice & { agentId: string | null },
  agentId: string,
  next?: Choice,
) {
  if (!current.agentId) return false;
  if (current.agentId !== agentId) return true;
  if (!next) return false;
  return (
    current.service?.id !== next.service?.id ||
    current.service?.model !== next.service?.model ||
    current.service?.revision !== next.service?.revision ||
    ordered(current.config) !== ordered(next.config)
  );
}
