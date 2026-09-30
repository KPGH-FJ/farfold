import {
  AGENT_BRANDS,
  agentIdentity,
  type AgentCardModel,
} from "../runtime/agents";
import { useState } from "react";

/** Brand artwork is presentation data; Agent behavior remains capability-driven. */
export function AgentLogo({ card }: { card: AgentCardModel }) {
  const brand = !card.custom ? AGENT_BRANDS[card.id] : undefined;
  const identity = agentIdentity(card.id, card.name);
  const [failed, setFailed] = useState<string | null>(null);
  const catalogIcon = card.icon?.startsWith("https://") ? card.icon : null;
  const logo = brand?.logo ?? catalogIcon;
  return logo && failed !== logo ? (
    <img
      className="agent-logo"
      data-monochrome={brand?.monochrome || undefined}
      src={logo}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(logo)}
      alt=""
    />
  ) : (
    <span className={`id agent-logo ${identity.cls}`}>{identity.letter}</span>
  );
}
