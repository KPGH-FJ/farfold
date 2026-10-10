import type { InventoryResult } from "../runtime/extension_inventory_controller";
import { EXTENSION_INVENTORY_STRINGS as S } from "../runtime/extension_inventory_strings";
import { SKILL_MANAGEMENT_STRINGS as M } from "../runtime/skill_management_strings";
import type { SkillInventoryItem } from "../runtime/extension_inventory_types";

/** Plain report metadata only; descriptions never become links or draft content. */
export function AgentExtensionInventoryResult({
  result,
  stale,
  management,
}: {
  result: InventoryResult;
  stale: boolean;
  management?: { enabled: boolean; inspect(item: SkillInventoryItem): void };
}) {
  const snapshot = result.snapshot;
  const observed = new Date(snapshot.observedAtMs);
  return (
    <div className="agent-extension-result">
      {stale && (
        <p role="status" className="auth-note">
          {S.stale}
        </p>
      )}
      <p className="agent-extension-directory">{result.cwd}</p>
      <p>
        {S.observed}：
        <time>
          {Number.isNaN(observed.valueOf())
            ? S.timeUnavailable
            : observed.toLocaleString()}
        </time>
      </p>
      <p>{snapshot.source === "officialCli" ? S.source : S.skillSource}</p>
      {snapshot.source === "officialAppServer" && !snapshot.complete && (
        <p role="status">
          {S.partial}
          {snapshot.errorCount}
        </p>
      )}
      {snapshot.items.length === 0 ? (
        snapshot.complete && (
          <p>{snapshot.source === "officialCli" ? S.empty : S.skillEmpty}</p>
        )
      ) : (
        <ul className="agent-extension-items">
          {snapshot.source === "officialCli"
            ? snapshot.items.map((item) => (
                <li key={item.id}>
                  <strong>{item.name ?? S.unnamed}</strong>
                  <span>{S.transport[item.transport]}</span>
                  <span>{item.reportedEnabled ? S.enabled : S.disabled}</span>
                  <span>
                    {S.auth}：{S.authentication[item.reportedAuth]}
                  </span>
                </li>
              ))
            : snapshot.items.map((item) => (
                <li key={item.id}>
                  <strong>{item.name ?? S.unnamed}</strong>
                  <span>
                    {item.reportedEnabled ? S.skillEnabled : S.skillDisabled}
                  </span>
                  <span>
                    {S.origin}：{S.origins[item.origin]}
                  </span>
                  {item.pluginReported && <span>{S.pluginReported}</span>}
                  {item.description !== null && (
                    <p className="agent-extension-description">
                      {item.description}
                    </p>
                  )}
                  {item.descriptionTruncated && (
                    <span>{S.descriptionTruncated}</span>
                  )}
                  {item.descriptionRedacted && (
                    <span>{S.descriptionRedacted}</span>
                  )}
                  {management &&
                  item.enablement.availability === "reviewable" ? (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={stale || !management.enabled}
                      onClick={() => {
                        if (!stale && management.enabled)
                          management.inspect(item);
                      }}
                    >
                      {item.reportedEnabled ? M.reviewDisable : M.reviewEnable}
                    </button>
                  ) : management &&
                    item.enablement.availability === "unavailable" ? (
                    <span>{M.reasons[item.enablement.reason]}</span>
                  ) : null}
                </li>
              ))}
        </ul>
      )}
    </div>
  );
}
