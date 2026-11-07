import { MCP_REMOVE_STRINGS as R } from "../runtime/mcp_remove_strings";
import type { InventoryResult } from "../runtime/extension_inventory_controller";
import { EXTENSION_INVENTORY_STRINGS as S } from "../runtime/extension_inventory_strings";
import { SKILL_MANAGEMENT_STRINGS as M } from "../runtime/skill_management_strings";
import { MCP_MANAGEMENT_STRINGS as C } from "../runtime/mcp_management_strings";
import { SKILL_PREFERENCE_REMOVE_STRINGS as CLEAR } from "../runtime/skill_preference_remove_strings";
import type {
  InventoryItem,
  SkillInventoryItem,
} from "../runtime/extension_inventory_types";

/** Plain report metadata only; descriptions never become links or draft content. */
export function AgentExtensionInventoryResult({
  result,
  stale,
  management,
  removal,
  skillPreferenceRemoval,
}: {
  result: InventoryResult;
  stale: boolean;
  removal?: { enabled: boolean; inspect(item: InventoryItem): void };
  skillPreferenceRemoval?: {
    enabled: boolean;
    inspect(item: SkillInventoryItem): void;
  };
  management?: {
    enabled: boolean;
    inspect(
      item: SkillInventoryItem | InventoryItem,
      requestedEnabled?: boolean,
    ): void;
  };
}) {
  const snapshot = result.snapshot;
  const extraRoots = result.request.extraSkillRoots ?? [];
  const discoveryOnly = extraRoots.length > 0;
  const allowedManagement = discoveryOnly ? undefined : management;
  const observed = new Date(snapshot.observedAtMs);
  return (
    <div className="agent-extension-result">
      {stale && (
        <p role="status" className="auth-note">
          {S.stale}
        </p>
      )}
      <p className="agent-extension-directory">{result.cwd}</p>
      {discoveryOnly && (
        <div className="agent-extension-directory">
          <strong>{S.extraSkillDirectory}</strong>
          {extraRoots.map((root, index) => (
            <span key={index}>{root}</span>
          ))}
          <p>{S.extraSkillReadOnly}</p>
        </div>
      )}
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
      {snapshot.source === "officialCli" && allowedManagement && (
        <p>{C.applicability}</p>
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
                  {allowedManagement &&
                  item.enablement?.availability === "available" ? (
                    [true, false].map((enabled) => (
                      <button
                        key={String(enabled)}
                        type="button"
                        className="btn btn-ghost"
                        disabled={stale || !allowedManagement.enabled}
                        onClick={() => {
                          if (!stale && allowedManagement.enabled)
                            allowedManagement.inspect(item, enabled);
                        }}
                      >
                        {enabled ? C.reviewEnable : C.reviewDisable}
                      </button>
                    ))
                  ) : allowedManagement ? (
                    <span>
                      {item.enablement?.availability === "unavailable"
                        ? C.reasons[item.enablement.reason]
                        : C.legacy}
                    </span>
                  ) : null}
                  {removal &&
                    !discoveryOnly &&
                    snapshot.complete &&
                    item.reportedEnabled === false &&
                    item.enablement?.availability === "available" &&
                    item.name &&
                    item.transport !== "unknown" && (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={stale || !removal.enabled}
                        onClick={() => {
                          if (!stale && removal.enabled) removal.inspect(item);
                        }}
                      >
                        {R.reviewRemove}
                      </button>
                    )}
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
                  {allowedManagement &&
                  item.enablement.availability === "reviewable" ? (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={stale || !allowedManagement.enabled}
                      onClick={() => {
                        if (!stale && allowedManagement.enabled)
                          allowedManagement.inspect(item);
                      }}
                    >
                      {item.reportedEnabled ? M.reviewDisable : M.reviewEnable}
                    </button>
                  ) : allowedManagement &&
                    item.enablement.availability === "unavailable" ? (
                    <span>{M.reasons[item.enablement.reason]}</span>
                  ) : null}
                  {skillPreferenceRemoval &&
                    !discoveryOnly &&
                    snapshot.complete &&
                    item.name &&
                    !item.pluginReported &&
                    ["user", "repo"].includes(item.origin) &&
                    item.enablement.availability === "reviewable" && (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={stale || !skillPreferenceRemoval.enabled}
                        onClick={() => {
                          if (!stale && skillPreferenceRemoval.enabled)
                            skillPreferenceRemoval.inspect(item);
                        }}
                      >
                        {CLEAR.reviewRemove}
                      </button>
                    )}
                </li>
              ))}
        </ul>
      )}
    </div>
  );
}
