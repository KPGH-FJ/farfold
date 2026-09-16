import { useState, type ReactNode } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";

export interface ProviderCatalogItem {
  id: string;
  name: string;
  configured: boolean;
  status: string;
  tone: "" | "configured" | "verified" | "failed";
  detail?: string;
}

interface Props {
  items: readonly ProviderCatalogItem[];
  selectedId: string;
  preferredId?: string | null;
  disabled: boolean;
  loading?: boolean;
  onSelect: (id: string) => void;
  children?: ReactNode;
}

// Runtime adapters provide status copy and evidence. This view never infers
// authentication or request success from a catalog entry.
export function ProviderCatalog({
  items,
  selectedId,
  preferredId,
  disabled,
  loading = false,
  onSelect,
  children,
}: Props) {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLocaleLowerCase();
  const visible = items
    .filter((item) =>
      `${item.name} ${item.id}`.toLocaleLowerCase().includes(normalized),
    )
    .sort(
      (left, right) =>
        Number(right.id === preferredId) - Number(left.id === preferredId) ||
        Number(right.configured) - Number(left.configured) ||
        left.name.localeCompare(right.name),
    );
  return (
    <aside className="connection-sidebar">
      <label>
        <MagnifyingGlass size={15} />
        <input
          data-provider-search
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索模型服务"
          aria-label="搜索模型服务"
        />
      </label>
      <nav aria-label="模型服务列表" aria-busy={loading}>
        {loading ? (
          <p className="provider-catalog-message" role="status">
            正在读取服务列表…
          </p>
        ) : visible.length === 0 ? (
          <p className="provider-catalog-message" role="status">
            {normalized ? "没有匹配的模型服务" : "尚无可显示的模型服务"}
          </p>
        ) : (
          visible.map((item) => (
            <button
              type="button"
              key={item.id}
              className={item.id === selectedId ? "selected" : ""}
              aria-pressed={item.id === selectedId}
              onClick={() => onSelect(item.id)}
              disabled={disabled}
            >
              <span className="provider-monogram">
                {item.name.slice(0, 1).toLocaleUpperCase()}
              </span>
              <span>
                <strong>{item.name}</strong>
                <small>
                  {item.id}
                  {item.detail ? ` · ${item.detail}` : ""}
                </small>
                <small>{item.status}</small>
              </span>
              <i className={item.tone} aria-hidden="true" />
            </button>
          ))
        )}
      </nav>
      {children}
    </aside>
  );
}
