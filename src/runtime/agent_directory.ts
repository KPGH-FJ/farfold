import type { AgentCardModel } from "./agents";
import { ACCESS_STRINGS as S } from "./access_strings";

export type DirectoryCategory = (typeof S.categories)[number];

/** Only reviewed presentation metadata supplies localized descriptions and tags. */
export function agentDirectoryDescription(card: AgentCardModel): string {
  if (card.custom) return S.directoryCustomDescription;
  if (card.presentation) return card.presentation.description;
  if (card.status === "connected" || card.status === "installed")
    return S.directoryInstalledDescription;
  if (card.registerable) return S.directoryDiscoveredDescription;
  if (card.installable) return S.directoryInstallDescription;
  return S.directoryExternalDescription;
}

/** Prefer the reviewed publisher; unknown entries retain the actual source host. */
export function agentDirectorySource(card: AgentCardModel): string | null {
  if (!card.custom && card.presentation) return card.presentation.publisher;
  try {
    const source = new URL(card.sourceUrl || card.installGuide || "");
    return source.protocol === "https:" || source.protocol === "http:"
      ? source.hostname.replace(/^www\./, "")
      : null;
  } catch {
    return null;
  }
}

export function agentDirectoryCategories(card: AgentCardModel) {
  return card.custom ? [] : (card.presentation?.categories ?? []);
}

export function matchesAgentDirectory(
  card: AgentCardModel,
  query: string,
  category: DirectoryCategory = "全部",
) {
  if (category !== "全部" && !agentDirectoryCategories(card).includes(category))
    return false;
  const value = query.trim().toLocaleLowerCase();
  return [
    card.name,
    card.description,
    agentDirectoryDescription(card),
    agentDirectorySource(card) ?? "",
    ...agentDirectoryCategories(card),
  ]
    .join(" ")
    .toLocaleLowerCase()
    .includes(value);
}
