import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { PlusIcon, XIcon } from "@phosphor-icons/react";
import type { BrowserWorkspaceClient } from "../runtime/browser_workspace";
import { BrowserTabs } from "../runtime/browser_tabs";
import { BROWSER_WORKSPACE_STRINGS as S } from "../runtime/browser_workspace_strings";
import {
  BrowserWorkspacePage,
  type BrowserWorkspaceProps as PageProps,
} from "./BrowserWorkspacePage";

export interface BrowserWorkspaceProps extends Omit<
  PageProps,
  "client" | "initialPage" | "onCloseReady" | "presentationSuspended"
> {
  client: BrowserWorkspaceClient;
  /** Includes pending native opens, so leaving a task never drops an owner. */
  onOwnersChange?: (ownsPages: boolean) => void;
}

/** Runtime-only tabs. Page controls and native scopes remain one common implementation. */
export function BrowserWorkspace({
  client,
  taskKey,
  onOwnersChange,
  onStateChange,
  onVisibilityChange,
  ...props
}: BrowserWorkspaceProps) {
  const tabs = useMemo(
    () => new BrowserTabs(client, taskKey),
    [client, taskKey],
  );
  const state = useSyncExternalStore(
    tabs.subscribe,
    tabs.getSnapshot,
    tabs.getSnapshot,
  );
  const prefix = useId();
  const callbacks = useRef({
    onOwnersChange,
    onStateChange,
    onVisibilityChange,
  });
  callbacks.current = { onOwnersChange, onStateChange, onVisibilityChange };
  tabs.setActive(props.active && (props.visible ?? true));
  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    void tabs.start().then((unlisten) => {
      if (live) stop = unlisten;
      else unlisten();
    });
    return () => {
      live = false;
      stop?.();
      tabs.retire();
    };
  }, [tabs]);
  const selected = state.tabs.find((tab) => tab.id === state.selected);
  const page = selected?.page ?? null;
  useLayoutEffect(() => {
    const notify = () =>
      callbacks.current.onOwnersChange?.(
        tabs
          .getSnapshot()
          .tabs.some((tab) => !!tab.page || tab.opening || tab.closing),
      );
    // Notify synchronously when open reserves its owner, before a route can
    // unmount this task while the native create reply is still pending.
    const stop = tabs.subscribe(notify);
    notify();
    return stop;
  }, [tabs]);
  useEffect(() => {
    callbacks.current.onStateChange?.(page);
  }, [page]);
  const suspended = state.changing || state.failed || !state.ready;
  return (
    <div className="browser-workspace-tabs-shell">
      {props.active && (
        <>
          <div className="browser-workspace-tabs-row">
            <div
              role="tablist"
              aria-label={S.tabs}
              className="browser-workspace-tabs"
              onKeyDown={(event) => {
                const buttons = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    '[role="tab"]',
                  ),
                );
                const index = buttons.indexOf(
                  event.target as HTMLButtonElement,
                );
                if (index < 0) return;
                const next =
                  event.key === "ArrowRight"
                    ? (index + 1) % buttons.length
                    : event.key === "ArrowLeft"
                      ? (index + buttons.length - 1) % buttons.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? buttons.length - 1
                          : -1;
                if (next >= 0) {
                  event.preventDefault();
                  buttons[next]?.focus();
                }
              }}
            >
              {state.tabs.map((tab, index) => {
                const title =
                  tab.page?.localFileName || tab.page?.url || S.newTab;
                return (
                  <div className="browser-workspace-tab" key={tab.id}>
                    <button
                      type="button"
                      role="tab"
                      id={`${prefix}-${tab.id}`}
                      aria-controls={`${prefix}-panel-${tab.id}`}
                      aria-selected={tab.id === state.selected}
                      tabIndex={tab.id === state.selected ? 0 : -1}
                      title={title}
                      disabled={state.changing || tab.closing}
                      onClick={() => void tabs.select(tab.id)}
                    >
                      <span>{tab.opening ? S.loading : title}</span>
                    </button>
                    <button
                      type="button"
                      className="browser-workspace-tab-close"
                      aria-label={S.closeTab(title)}
                      title={S.close}
                      disabled={state.changing || tab.closing}
                      onClick={() => void tabs.close(tab.id)}
                    >
                      <XIcon size={12} aria-hidden="true" />
                    </button>
                    <span className="browser-workspace-sr-only">
                      {index + 1}
                    </span>
                  </div>
                );
              })}
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label={S.addTab}
              title={S.addTab}
              disabled={state.changing || !state.ready}
              onClick={() => void tabs.add()}
            >
              <PlusIcon size={16} aria-hidden="true" />
            </button>
          </div>
          {!state.failed &&
            !state.changing &&
            page &&
            !tabs.isSelected(state.selected) && (
              <div className="browser-tabs-error" role="status">
                {S.waitingSelection}
                <button
                  type="button"
                  onClick={() => void tabs.select(state.selected)}
                >
                  {S.showSelected}
                </button>
              </div>
            )}
          {state.failed && (
            <div className="browser-tabs-error" role="alert">
              {S.selectionFailed}
              <button
                type="button"
                onClick={() => void tabs.select(state.selected)}
              >
                {S.retrySelection}
              </button>
            </div>
          )}
        </>
      )}
      {state.tabs.map((tab) => (
        <div
          key={tab.id}
          id={`${prefix}-panel-${tab.id}`}
          role="tabpanel"
          aria-labelledby={`${prefix}-${tab.id}`}
          hidden={!props.active || state.selected !== tab.id}
          className="browser-workspace-tab-panel"
        >
          <fieldset
            disabled={suspended || tab.closing}
            className="browser-workspace-tab-controls"
          >
            <BrowserWorkspacePage
              {...props}
              taskKey={taskKey}
              client={tabs.pageClient(tab.id)}
              initialPage={tab.page}
              active={props.active && state.selected === tab.id}
              presentationSuspended={suspended}
              htmlRequest={state.selected === tab.id ? props.htmlRequest : null}
              toolbar={state.selected === tab.id ? props.toolbar : null}
              onStateChange={(next) => tabs.observe(tab.id, next)}
              onCloseReady={(close) => tabs.registerCloser(tab.id, close)}
              onVisibilityChange={(visible) => {
                if (tabs.getSnapshot().selected === tab.id)
                  callbacks.current.onVisibilityChange?.(visible);
              }}
            />
          </fieldset>
        </div>
      ))}
    </div>
  );
}
