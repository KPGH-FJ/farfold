import type { AgentCardModel } from "./agents";
import { ACCESS_STRINGS as S } from "./access_strings";
import { agentBrand } from "./agent_brands";

export type DirectoryCategory = (typeof S.categories)[number];

/** Daily entry points exclude retired catalog rows; historical callers keep all cards. */
export function isAgentPresentable(card: AgentCardModel): boolean {
  return (
    card.custom ||
    card.source === "custom" ||
    card.source === "discovered" ||
    card.status === "discovered" ||
    card.firstBatchVisible !== false
  );
}

export function presentableAgents(cards: AgentCardModel[]): AgentCardModel[] {
  return cards.filter(isAgentPresentable);
}

/** Admits a new-conversation choice; never represents a successful model request. */
export function isAgentReadyForConversation(
  card: AgentCardModel,
  prepared: boolean,
): boolean {
  return (
    isAgentPresentable(card) &&
    (card.status === "connected" || card.status === "installed") &&
    prepared
  );
}

/** Only reviewed presentation metadata supplies localized descriptions and tags. */
export function agentDirectoryDescription(card: AgentCardModel): string {
  if (card.custom) return S.directoryCustomDescription;
  const brand = agentBrand(card);
  if (brand) return brand.description;
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
