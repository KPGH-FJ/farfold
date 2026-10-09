import type { AgentSetupSelection } from "./AgentSetup";
import type { Credential } from "../runtime/credentials";
import type { ConfigOptionView } from "../runtime/session_types";
import { AGENT_REDESIGN as U } from "../runtime/agent_redesign_strings";

/** Compare recorded choices without substituting a different service revision. */
export function selectionReviewRows(
  before: AgentSetupSelection,
  after: AgentSetupSelection,
  services: Credential[],
  options: ConfigOptionView[],
): { name: string; before: string; after: string }[] {
  const source = (selection: AgentSetupSelection) => {
    if (!selection.service) return U.existingSource;
    const service = services.find(
      (item) =>
        item.id === selection.service?.id &&
        item.revision === selection.service.revision,
    );
    return service
      ? `${service.label} · ${service.endpoint}`
      : U.selectedSource;
  };
  const value = (id: string, raw: unknown) => {
    if (raw === undefined) return U.configurationUnknown;
    if (typeof raw === "boolean" || typeof raw === "number") return String(raw);
    if (typeof raw !== "string") return U.notProvided;
    const option = options.find((item) => item.id === id);
    return option?.options.find((item) => item.value === raw)?.name ?? raw;
  };
  return [
    { name: U.source, before: source(before), after: source(after) },
    ...(before.service || after.service
      ? [
          {
            name: U.model,
            before: before.service?.model || U.configurationUnknown,
            after: after.service?.model || U.configurationUnknown,
          },
        ]
      : []),
    ...Array.from(
      new Set([...Object.keys(before.config), ...Object.keys(after.config)]),
    ).map((id) => ({
      name: options.find((item) => item.id === id)?.name ?? id,
      before: value(id, before.config[id]),
      after: value(id, after.config[id]),
    })),
  ];
}

export function AgentSelectionReview({
  before,
  after,
  services,
  options,
}: {
  before: AgentSetupSelection;
  after: AgentSetupSelection;
  services: Credential[];
  options: ConfigOptionView[];
}) {
  const rows = selectionReviewRows(before, after, services, options);
  const changed =
    JSON.stringify(before.service) !== JSON.stringify(after.service) ||
    Object.keys({ ...before.config, ...after.config }).some(
      (id) => before.config[id] !== after.config[id],
    );
  if (!changed) return null;
  return (
    <section className="agent-selection-diff" aria-label={U.comparison}>
      <h4>{U.comparison}</h4>
      <table>
        <thead>
          <tr>
            <th scope="col">{U.otherOptions}</th>
            <th scope="col">{U.before}</th>
            <th scope="col">{U.after}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <th scope="row">{row.name}</th>
              <td>{row.before}</td>
              <td>{row.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>{U.settingsScope}</p>
    </section>
  );
}
