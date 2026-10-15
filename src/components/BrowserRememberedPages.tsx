import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  RememberedBrowserPages,
  rememberablePage,
  type RememberedBrowserOpen,
  type RememberedBrowserOwner,
  type RememberedBrowserPagesClient,
} from "../runtime/browser_remembered";
import type { BrowserWorkspaceState } from "../runtime/browser_workspace";
import { REMEMBERED_BROWSER_STRINGS as S } from "../runtime/browser_remembered_strings";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { DangerConfirm } from "./DangerConfirm";

export interface BrowserRememberedPagesProps {
  owner: RememberedBrowserOwner | null;
  page: BrowserWorkspaceState | null;
  active: boolean;
  client: RememberedBrowserPagesClient;
  onOpen: (input: RememberedBrowserOpen) => Promise<boolean>;
}

/** All Agents use this URL-only list; no saved entry is opened by rendering it. */
export function BrowserRememberedPages(props: BrowserRememberedPagesProps) {
  const { owner, active, page, client, onOpen } = props;
  const model = useMemo(
    () => (owner ? new RememberedBrowserPages(client, { ...owner }) : null),
    [client, owner?.sessionId, owner?.createdAt],
  );
  // Keying the body also retires confirmation/launch state on owner replacement.
  return model ? (
    <RememberedPagesBody
      key={`${owner!.sessionId}:${owner!.createdAt}`}
      model={model}
      active={active}
      page={page}
      onOpen={onOpen}
    />
  ) : (
    <span className="browser-remembered-unavailable">{S.draft}</span>
  );
}

function RememberedPagesBody({
  model,
  active,
  page,
  onOpen,
}: {
  model: RememberedBrowserPages;
  active: boolean;
  page: BrowserWorkspaceState | null;
  onOpen: BrowserRememberedPagesProps["onOpen"];
}) {
  const state = useSyncExternalStore(
    model.subscribe,
    model.getSnapshot,
    model.getSnapshot,
  );
  const [dialog, setDialog] = useState<"remember" | "list" | null>(null);
  const [choice, setChoice] = useState<BrowserWorkspaceState | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [clear, setClear] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [launchFailed, setLaunchFailed] = useState(false);
  const rememberButton = useRef<HTMLButtonElement>(null);
  const listButton = useRef<HTMLButtonElement>(null);
  const lifecycle = useRef(0);
  const current = useRef({ active, page });
  current.current = { active, page };
  useEffect(() => {
    const epoch = ++lifecycle.current;
    void model.start();
    return () => {
      if (lifecycle.current === epoch) ++lifecycle.current;
      model.retire();
    };
  }, [model]);
  const exactChoice =
    !!choice &&
    page?.taskKey === choice.taskKey &&
    page.label === choice.label &&
    page.revision === choice.revision &&
    page.url === choice.url &&
    rememberablePage(page);
  useEffect(() => {
    if (!active || (dialog === "remember" && !exactChoice)) {
      setDialog(null);
      setChoice(null);
      setConfirmed(false);
      setClear(false);
    }
  }, [active, dialog, exactChoice]);
  const busy = !!state.busy || launching;
  const already =
    !!page && state.list.items.some((item) => item.url === page.url);
  const canChange = state.ready && !state.error && !busy;
  const error = state.message;
  const atLimit = state.list.items.length >= 100;
  const dismiss = () => {
    if (busy) return;
    setDialog(null);
    setChoice(null);
    setConfirmed(false);
    setClear(false);
  };
  async function save() {
    const visible = current.current;
    if (
      !visible.active ||
      !choice ||
      !confirmed ||
      !exactChoice ||
      !canChange ||
      !rememberablePage(visible.page) ||
      visible.page?.taskKey !== choice.taskKey ||
      visible.page?.label !== choice.label ||
      visible.page.revision !== choice.revision ||
      visible.page.url !== choice.url
    )
      return;
    const epoch = lifecycle.current;
    const saved = await model.remember(choice);
    if (saved && epoch === lifecycle.current && current.current.active) {
      setDialog(null);
      setChoice(null);
      setConfirmed(false);
    }
  }
  async function open(itemId: string) {
    if (!current.current.active || launching) return;
    const request = model.opening(itemId);
    if (!request) return;
    const epoch = lifecycle.current;
    setLaunching(true);
    setLaunchFailed(false);
    try {
      const accepted = await onOpen(request);
      if (epoch !== lifecycle.current || !current.current.active) return;
      if (accepted) setDialog(null);
      else setLaunchFailed(true);
    } catch {
      if (epoch === lifecycle.current && current.current.active)
        setLaunchFailed(true);
    } finally {
      if (epoch === lifecycle.current) setLaunching(false);
    }
  }
  return (
    <div className="browser-remembered-actions">
      <button
        type="button"
        ref={rememberButton}
        disabled={
          !active || !canChange || !rememberablePage(page) || already || atLimit
        }
        title={
          atLimit ? S.limit : !rememberablePage(page) ? S.publicOnly : undefined
        }
        onClick={() => {
          if (!page || !rememberablePage(page) || !canChange) return;
          setChoice({ ...page });
          setConfirmed(false);
          setDialog("remember");
        }}
      >
        {already ? S.remembered : S.remember}
      </button>
      <button
        type="button"
        ref={listButton}
        disabled={!active || launching}
        onClick={() => {
          setClear(false);
          setLaunchFailed(false);
          setDialog("list");
        }}
      >
        {S.list}
        {state.ready ? ` (${state.list.items.length})` : ""}
      </button>
      {active && dialog && (
        <WorkspaceDialog
          title={dialog === "remember" ? S.confirmTitle : S.list}
          busy={busy}
          onClose={dismiss}
          returnFocusRef={dialog === "remember" ? rememberButton : listButton}
        >
          <div className="workspace-dialog-body browser-remembered-dialog">
            {dialog === "remember" ? (
              <>
                <p>{S.confirmNote}</p>
                <p className="browser-remembered-url" dir="ltr">
                  {choice?.url}
                </p>
                <label className="browser-remembered-confirmation">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={busy || !exactChoice}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  {S.secretConfirmation}
                </label>
                <p>{S.noPermission}</p>
                <div className="browser-remembered-footer">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busy}
                    onClick={dismiss}
                  >
                    {S.cancel}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!confirmed || !exactChoice || !canChange}
                    onClick={() => void save()}
                  >
                    {S.remember}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>{S.dormant}</p>
                <p>{S.noPermission}</p>
                {state.busy === "load" && <p role="status">{S.loading}</p>}
                {state.ready && !state.list.items.length && <p>{S.empty}</p>}
                <ol className="browser-remembered-list">
                  {state.list.items.map((item) => (
                    <li key={item.id}>
                      <p className="browser-remembered-url" dir="ltr">
                        {item.url}
                      </p>
                      <div className="browser-remembered-footer">
                        <button
                          type="button"
                          className="btn btn-ghost"
                          disabled={!canChange}
                          onClick={() => void open(item.id)}
                          aria-label={`${S.open}：${item.url}`}
                        >
                          {S.open}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          disabled={!canChange}
                          onClick={() => void model.forget(item.id)}
                          aria-label={`${S.forget}：${item.url}`}
                        >
                          {S.forget}
                        </button>
                      </div>
                    </li>
                  ))}
                </ol>
                {!!state.list.items.length && !clear && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={!canChange}
                    onClick={() => setClear(true)}
                  >
                    {S.clear}
                  </button>
                )}
                {clear && (
                  <DangerConfirm
                    confirmLabel={S.clear}
                    busy={busy}
                    confirmDisabled={!canChange}
                    onCancel={() => setClear(false)}
                    onConfirm={() => {
                      const epoch = lifecycle.current;
                      void model.forget(null).then((done) => {
                        if (done && epoch === lifecycle.current)
                          setClear(false);
                      });
                    }}
                  >
                    <p>{S.clearTitle}</p>
                    <p>{S.clearNote}</p>
                  </DangerConfirm>
                )}
                {launchFailed && <p role="alert">{S.openFailed}</p>}
              </>
            )}
            {error && <p role="alert">{error}</p>}
            {state.error === "unknown" && error !== S.unknown && (
              <p>{S.unknown}</p>
            )}
            {state.error && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => void model.refresh()}
              >
                {S.recheck}
              </button>
            )}
          </div>
        </WorkspaceDialog>
      )}
    </div>
  );
}
