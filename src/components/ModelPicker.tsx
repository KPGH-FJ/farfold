import { useEffect, useMemo, useRef, useState } from "react";
import {
  Brain,
  CaretDown,
  Check,
  ImageSquare,
  MagnifyingGlass,
  SlidersHorizontal,
} from "@phosphor-icons/react";
import type {
  PiModel,
  PiProvider,
  PiSettingsSnapshot,
  ThinkingLevel,
} from "../runtime/capabilities";
import {
  hasLoadedModel,
  type ModelReference,
} from "../runtime/pi-model-selection";

interface ModelPickerProps {
  current: PiModel | null;
  thinkingLevel: ThinkingLevel;
  availableThinkingLevels: ThinkingLevel[];
  models: PiModel[];
  loadedModels: readonly ModelReference[];
  providers: PiProvider[];
  settings: PiSettingsSnapshot | null;
  running: boolean;
  working: boolean;
  refreshing: boolean;
  onSelect: (model: PiModel) => Promise<void>;
  onThinkingLevel: (level: ThinkingLevel) => Promise<void>;
  onSetDefault?: (model: PiModel, level: ThinkingLevel) => Promise<void>;
  onConfigureProvider: (providerId?: string) => void;
  onRefresh: () => void;
}

export function modelKey(model: Pick<PiModel, "provider" | "id">): string {
  return `${model.provider}\u0000${model.id}`;
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

export function filterModels(models: PiModel[], query: string): PiModel[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return models;
  return models.filter((model) =>
    `${model.name} ${model.id} ${model.provider} ${model.api}`
      .toLocaleLowerCase()
      .includes(normalized),
  );
}

export function ModelPicker({
  current,
  thinkingLevel,
  availableThinkingLevels,
  models,
  loadedModels,
  providers,
  settings,
  running,
  working,
  refreshing,
  onSelect,
  onThinkingLevel,
  onSetDefault,
  onConfigureProvider,
  onRefresh,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"available" | "all">("available");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const providerById = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider])),
    [providers],
  );
  const currentKey = current ? modelKey(current) : null;
  const defaultKey =
    settings?.defaultProvider && settings.defaultModel
      ? `${settings.defaultProvider}\u0000${settings.defaultModel}`
      : null;

  const visibleModels = useMemo(() => {
    const scoped =
      scope === "available"
        ? models.filter((model) => model.available)
        : models;
    return filterModels(scoped, query).sort((left, right) => {
      const leftCurrent = modelKey(left) === currentKey ? 1 : 0;
      const rightCurrent = modelKey(right) === currentKey ? 1 : 0;
      if (leftCurrent !== rightCurrent) return rightCurrent - leftCurrent;
      const leftProvider = providerById.get(left.provider);
      const rightProvider = providerById.get(right.provider);
      if (leftProvider?.configured !== rightProvider?.configured) {
        return (
          Number(rightProvider?.configured) - Number(leftProvider?.configured)
        );
      }
      return `${leftProvider?.name || left.provider}/${left.name}`.localeCompare(
        `${rightProvider?.name || right.provider}/${right.name}`,
      );
    });
  }, [currentKey, models, providerById, query, scope]);

  const groups = useMemo(() => {
    const grouped = new Map<string, PiModel[]>();
    for (const model of visibleModels.slice(0, 250)) {
      const list = grouped.get(model.provider) || [];
      list.push(model);
      grouped.set(model.provider, list);
    }
    return [...grouped.entries()];
  }, [visibleModels]);

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    function close(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        window.setTimeout(() => trigger.current?.focus(), 0);
      }
    }
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="model-switcher" ref={root}>
      <button
        ref={trigger}
        className="model-trigger"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={working ? "当前任务结束后可切换模型" : "选择 Pi 模型"}
      >
        <span>
          <small>{current?.provider || "Pi Model"}</small>
          <strong>{current?.name || current?.id || "选择模型"}</strong>
        </span>
        <CaretDown size={13} />
      </button>

      {open && (
        <section
          className="model-popover"
          role="dialog"
          aria-label="选择 Pi 模型"
        >
          <header className="model-popover-header">
            <div>
              <strong>模型</strong>
              <span>{models.length} 个来自 Pi 的模型</span>
            </div>
            <button onClick={onRefresh} disabled={refreshing}>
              {refreshing ? "刷新中…" : "刷新目录"}
            </button>
          </header>

          {working && (
            <p className="model-lock-note">
              当前操作进行中。可以查看模型，操作结束后才能切换。
            </p>
          )}

          <label className="model-search">
            <MagnifyingGlass size={16} />
            <input
              ref={search}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索模型、ID 或 Provider"
              aria-label="搜索模型"
            />
          </label>

          <div className="model-scope" role="tablist" aria-label="模型范围">
            <button
              role="tab"
              aria-selected={scope === "available"}
              className={scope === "available" ? "active" : ""}
              onClick={() => setScope("available")}
            >
              可用
            </button>
            <button
              role="tab"
              aria-selected={scope === "all"}
              className={scope === "all" ? "active" : ""}
              onClick={() => setScope("all")}
            >
              全部模型
            </button>
          </div>

          <div className="model-results">
            {groups.length ? (
              groups.map(([providerId, providerModels]) => {
                const provider = providerById.get(providerId);
                return (
                  <section className="model-group" key={providerId}>
                    <header>
                      <span>{provider?.name || providerId}</span>
                      <small>
                        {provider?.configured ? "已连接" : "未连接"} ·{" "}
                        {providerModels.length}
                      </small>
                    </header>
                    {providerModels.map((model) => {
                      const key = modelKey(model);
                      const selected = key === currentKey;
                      const isDefault = key === defaultKey;
                      const needsReload =
                        running &&
                        model.available &&
                        !hasLoadedModel(loadedModels, model);
                      return (
                        <div
                          className={`model-row${selected ? " selected" : ""}`}
                          key={key}
                        >
                          <button
                            className="model-choice"
                            disabled={working || busyKey !== null}
                            onClick={() => {
                              if (!model.available) {
                                setOpen(false);
                                onConfigureProvider(model.provider);
                                return;
                              }
                              setBusyKey(key);
                              setSelectionError(null);
                              void onSelect(model)
                                .then(() => {
                                  setOpen(false);
                                  window.setTimeout(
                                    () => trigger.current?.focus(),
                                    0,
                                  );
                                })
                                .catch((reason) =>
                                  setSelectionError(String(reason)),
                                )
                                .finally(() => setBusyKey(null));
                            }}
                          >
                            <span className="model-check">
                              {selected && <Check size={13} weight="bold" />}
                            </span>
                            <span className="model-copy">
                              <strong>{model.name}</strong>
                              <small>{model.id}</small>
                            </span>
                            <span className="model-capabilities">
                              {model.reasoning && (
                                <Brain size={14} aria-label="支持推理" />
                              )}
                              {model.input.includes("image") && (
                                <ImageSquare size={14} aria-label="支持图像" />
                              )}
                              <small>
                                {formatTokenCount(model.contextWindow)} ctx
                              </small>
                            </span>
                            {!model.available && <em>连接 Provider</em>}
                            {needsReload && <em>重新加载并使用</em>}
                          </button>
                          {model.available && onSetDefault && (
                            <button
                              className={`model-default${isDefault ? " active" : ""}`}
                              disabled={working || busyKey !== null}
                              onClick={() => {
                                setBusyKey(`default:${key}`);
                                setSelectionError(null);
                                void onSetDefault(model, thinkingLevel)
                                  .catch((reason) =>
                                    setSelectionError(String(reason)),
                                  )
                                  .finally(() => setBusyKey(null));
                              }}
                              title={
                                isDefault
                                  ? "Pi 新会话默认模型"
                                  : "设为 Pi 新会话默认模型"
                              }
                            >
                              {isDefault ? "默认" : "设为默认"}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </section>
                );
              })
            ) : (
              <div className="model-empty">
                <SlidersHorizontal size={20} />
                <strong>
                  {scope === "available" ? "没有可用模型" : "没有匹配模型"}
                </strong>
                <span>
                  {scope === "available"
                    ? "先连接 Provider，再刷新 Pi 模型目录。"
                    : "尝试模型 ID 或 Provider 名称。"}
                </span>
                {scope === "available" && (
                  <button
                    onClick={() => {
                      setOpen(false);
                      onConfigureProvider();
                    }}
                  >
                    连接 Provider
                  </button>
                )}
              </div>
            )}
            {visibleModels.length > 250 && (
              <p className="model-result-limit">
                当前显示前 250 项，请继续输入关键词缩小范围。
              </p>
            )}
          </div>

          {selectionError && (
            <p className="model-lock-note" role="alert">
              {selectionError}
            </p>
          )}
          <footer className="thinking-control">
            <span>
              <Brain size={15} />
              Thinking
            </span>
            <div>
              {availableThinkingLevels.map((level) => (
                <button
                  className={level === thinkingLevel ? "active" : ""}
                  key={level}
                  onClick={() => {
                    setBusyKey(`thinking:${level}`);
                    setSelectionError(null);
                    void onThinkingLevel(level)
                      .catch((reason) => setSelectionError(String(reason)))
                      .finally(() => setBusyKey(null));
                  }}
                  disabled={
                    working || busyKey !== null || (!running && !current)
                  }
                >
                  {level}
                </button>
              ))}
            </div>
          </footer>
        </section>
      )}
    </div>
  );
}
