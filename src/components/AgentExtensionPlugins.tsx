import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { InventoryOwner } from "../runtime/extension_inventory_controller";
import { validInventoryDirectory } from "../runtime/extension_inventory_types";
import { pluginManagement } from "../runtime/plugin_management_controller";
import { PLUGIN_MANAGEMENT_STRINGS as S } from "../runtime/plugin_management_strings";
import { EXTENSION_INVENTORY_STRINGS as I } from "../runtime/extension_inventory_strings";
import { AgentExtensionPluginChange } from "./AgentExtensionPluginChange";

export function AgentExtensionPlugins({
  owner,
  cwd,
  selectionId,
  enabled,
  choosing,
  chooseDirectory,
}: {
  owner: InventoryOwner;
  cwd: string;
  selectionId: string | null;
  enabled: boolean;
  choosing: boolean;
  chooseDirectory(): void;
}) {
  const view = useSyncExternalStore(
    pluginManagement.subscribe,
    () => pluginManagement.get(owner.agentId),
    () => pluginManagement.get(owner.agentId),
  );
  const [marketplace, setMarketplace] = useState("");
  const [itemId, setItemId] = useState<number | null>(null);
  const result = view.result;
  const key = useMemo(
    () => ({}),
    [owner, cwd, selectionId, enabled, marketplace, itemId, result],
  );
  const live = useRef(key);
  live.current = key;
  useEffect(() => () => pluginManagement.retire(owner), [owner]);
  const allowed = () => enabled && owner.current() && live.current === key;
  const current = () =>
    !!result && allowed() && pluginManagement.isCurrentResult(owner, result);
  const stale =
    !!result &&
    (!enabled ||
      result.request.cwd !== cwd ||
      !pluginManagement.isCurrentResult(owner, result));
  const items = result?.catalog.items ?? [];
  const marketplaces = [
    ...new Set(
      items
        .map((item) => item.marketplaceName)
        .filter((name): name is string => name !== null),
    ),
  ];
  const selected = items.find(
    (item) => item.id === itemId && item.marketplaceName === marketplace,
  );
  const permission =
    selected &&
    (selected.reportedInstalled ? selected.remove : selected.install);
  const editable = current() && !view.unresolved;
  return (
    <div className="agent-extension-result">
      <p>{S.querySupport}</p>
      <div className="agent-extension-actions">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!enabled || choosing || view.unresolved}
          onClick={() => {
            if (allowed() && !view.unresolved) chooseDirectory();
          }}
        >
          {I.chooseDirectory}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={
            !enabled ||
            choosing ||
            view.unresolved ||
            !selectionId ||
            !validInventoryDirectory(cwd)
          }
          onClick={() => {
            if (allowed() && !view.unresolved && selectionId)
              pluginManagement.begin(owner, cwd, selectionId);
          }}
        >
          {result ? S.queryAgain : S.query}
        </button>
      </div>
      {cwd && (
        <p className="agent-extension-directory">
          {I.directory}: {cwd}
        </p>
      )}
      {result && (
        <>
          <p>
            {S.observedAt}:{" "}
            {Number.isFinite(new Date(result.catalog.observedAtMs).getTime())
              ? new Date(result.catalog.observedAtMs).toLocaleString()
              : S.unknown}
          </p>
          {stale && <p role="status">{S.stale}</p>}
          {!result.catalog.complete && <p>{S.partial}</p>}
          {!items.length ? (
            <p>{S.empty}</p>
          ) : (
            <>
              <label className="agent-extension-kind">
                <span>{S.marketplace}</span>
                <select
                  aria-label={S.marketplace}
                  value={marketplace}
                  disabled={!editable}
                  onChange={(event) => {
                    if (!current() || view.unresolved) return;
                    pluginManagement.retireInspection(owner);
                    const value = event.currentTarget.value;
                    setMarketplace(marketplaces.includes(value) ? value : "");
                    setItemId(null);
                  }}
                >
                  <option value="">{S.chooseMarketplace}</option>
                  {marketplaces.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="agent-extension-kind">
                <span>{S.package}</span>
                <select
                  aria-label={S.package}
                  value={selected?.id ?? ""}
                  disabled={!editable || !marketplace}
                  onChange={(event) => {
                    if (!current() || view.unresolved) return;
                    pluginManagement.retireInspection(owner);
                    const item = items.find(
                      (item) =>
                        String(item.id) === event.currentTarget.value &&
                        item.marketplaceName === marketplace,
                    );
                    setItemId(item?.id ?? null);
                  }}
                >
                  <option value="">{S.choosePackage}</option>
                  {items
                    .filter((item) => item.marketplaceName === marketplace)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name ?? S.unnamed}
                      </option>
                    ))}
                </select>
              </label>
              {selected && (
                <div className="agent-extension-progress">
                  <p>
                    {selected.reportedInstalled ? S.installed : S.notInstalled}
                  </p>
                  <p>{selected.reportedEnabled ? S.enabled : S.disabled}</p>
                  <p>
                    {S.source}: {S.sources[selected.source]}
                  </p>
                  <p>
                    {S.version}: {selected.version ?? S.unknown}
                  </p>
                  <p>
                    {S.installPolicy}: {S.policy[selected.installPolicy]}
                  </p>
                  <p>
                    {S.authPolicy}: {S.authentication[selected.authPolicy]}
                  </p>
                  {permission?.reason && <p>{S.reasons[permission.reason]}</p>}
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={
                      !editable || permission?.availability !== "available"
                    }
                    onClick={() => {
                      if (
                        current() &&
                        !view.unresolved &&
                        result &&
                        permission?.availability === "available"
                      )
                        pluginManagement.inspect(
                          owner,
                          result,
                          selected,
                          !selected.reportedInstalled,
                        );
                    }}
                  >
                    {selected.reportedInstalled
                      ? S.reviewRemove
                      : S.reviewInstall}
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
      <AgentExtensionPluginChange owner={owner} active={enabled} />
      <details>
        <summary>{S.details}</summary>
        <p>{S.scope}</p>
        <p>{S.cwdScope}</p>
        <p>{S.installNotice}</p>
        <p>{S.applicability}</p>
        <p>{S.external}</p>
      </details>
    </div>
  );
}
