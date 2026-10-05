import { open as chooseFile } from "@tauri-apps/plugin-dialog";
import { fileDelivery, type VerifiedFile } from "../runtime/file_delivery";
import { browserSurfaceGuard } from "../runtime/browser_surface";
import type {
  BrowserSurfaceGuard,
  BrowserSurfaceRegistration,
} from "../runtime/browser_surface_guard";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  BrowserWorkspaceRetiredError,
  BrowserWorkspaceScope,
  browserWorkspaceBounds,
  publicBrowserUrl,
  type BrowserWorkspaceBounds,
  type BrowserWorkspaceClient,
  type BrowserWorkspaceSnapshot,
  type BrowserWorkspaceState,
} from "../runtime/browser_workspace";
import {
  ArrowClockwiseIcon,
  ArrowRightIcon,
  ArrowSquareOutIcon,
  GlobeIcon,
  FileHtmlIcon,
  TextAlignLeftIcon,
  XIcon,
} from "@phosphor-icons/react";
import { BROWSER_WORKSPACE_STRINGS as S } from "../runtime/browser_workspace_strings";
import "../browser-workspace.css";

export interface BrowserWorkspaceProps {
  /** Trusted current conversation key, never a key supplied by a remote page. */
  taskKey: string;
  /** Current task work folder; never infer the project from a file access root. */
  projectDirectory?: string;
  /** False only when leaving this task/route or showing a covering overlay. */
  active: boolean;
  /** Collapse only hides the page; the owner and its permission stay alive. */
  visible?: boolean;
  /** Page metadata only, never the contents of a text snapshot. */
  onStateChange?: (state: BrowserWorkspaceState | null) => void;
  /** True holds layout while visible or opening/showing; false requires hide/close ACK. */
  onVisibilityChange?: (visible: boolean) => void;
  toolbar?: ReactNode;
  /** One explicit action from the verified-file view in this same task. */
  htmlRequest?: { taskKey: string; file: VerifiedFile } | null;
  onHtmlRequestConsumed?: () => void;
  /** Keep this object stable. Create one at the app's trusted composition boundary. */
  client: BrowserWorkspaceClient;
  /** The application coordinator retains failed closure outside hidden panes. */
  guard?: BrowserSurfaceGuard;
}

type Operation =
  | "open"
  | "navigate"
  | "snapshot"
  | "close"
  | "choose"
  | "external"
  | "clear"
  | null;

function phaseText(state: BrowserWorkspaceState | null): string {
  if (
    state?.localFileName !== undefined &&
    (state.phase === "blocked" || state.phase === "error")
  )
    return S.htmlFailed;
  switch (state?.phase) {
    case "loading":
      return S.loading;
    case "ready":
      return S.ready;
    case "blocked":
      return S.blocked;
    case "error":
      return S.loadFailed;
    case "closed":
      return S.closed;
    default:
      return "";
  }
}

function sameBounds(a: BrowserWorkspaceBounds, b: BrowserWorkspaceBounds) {
  return (
    Math.abs(a.x - b.x) < 0.25 &&
    Math.abs(a.y - b.y) < 0.25 &&
    Math.abs(a.width - b.width) < 0.25 &&
    Math.abs(a.height - b.height) < 0.25
  );
}

/** A content-pane body, not a new route or navigation shell. */
export function BrowserWorkspace({
  taskKey,
  projectDirectory,
  active,
  visible = true,
  onStateChange,
  onVisibilityChange,
  toolbar,
  htmlRequest,
  onHtmlRequestConsumed,
  client,
  guard = browserSurfaceGuard,
}: BrowserWorkspaceProps) {
  const addressId = useId();
  const hintId = useId();
  const errorId = useId();
  const surface = useRef<HTMLDivElement>(null);
  const scope = useRef<BrowserWorkspaceScope | null>(null);
  const sequence = useRef(0);
  const busy = useRef<Operation>(null);
  const mounted = useRef(true);
  const available = useRef({ taskKey, active, visible });
  available.current = { taskKey, active, visible };
  const localFile = useRef<VerifiedFile | null>(null);
  const choiceOwner = useRef<object | null>(null);
  const clearChoice = useRef<BrowserWorkspaceScope | null>(null);
  const consumedHtml = useRef<BrowserWorkspaceProps["htmlRequest"]>(null);
  const registrations = useRef(
    new Map<BrowserWorkspaceScope, BrowserSurfaceRegistration>(),
  );
  const callbacks = useRef({ onStateChange, onVisibilityChange });
  callbacks.current = { onStateChange, onVisibilityChange };
  const [address, setAddress] = useState("");
  const [state, setState] = useState<BrowserWorkspaceState | null>(null);
  const [snapshot, setSnapshot] = useState<BrowserWorkspaceSnapshot | null>(
    null,
  );
  const [operation, setOperation] = useState<Operation>(null);
  const [error, setError] = useState("");
  const [addressError, setAddressError] = useState(false);
  const [clearConfirmation, setClearConfirmation] =
    useState<BrowserWorkspaceScope | null>(null);
  const [storageNotice, setStorageNotice] = useState("");
  const [listening, setListening] = useState(false);
  const [blocked, setBlocked] = useState(guard.getSnapshot().blocked);
  const [guardRevision, setGuardRevision] = useState(0);
  useEffect(
    () =>
      guard.subscribe(() => {
        setBlocked(guard.getSnapshot().blocked);
        // A completed layout/overlay transition can leave active/visible unchanged.
        setGuardRevision((value) => value + 1);
      }),
    [guard],
  );

  function setClearPrompt(owner: BrowserWorkspaceScope | null) {
    clearChoice.current = owner;
    setClearConfirmation(owner);
  }

  async function closeOwner(owner: BrowserWorkspaceScope) {
    const isCurrent = () => mounted.current && scope.current === owner;
    if (isCurrent()) {
      ++sequence.current;
      busy.current = "close";
      setOperation("close");
      setSnapshot(null);
      setError("");
    }
    try {
      await owner.close();
      registrations.current.get(owner)?.release();
      registrations.current.delete(owner);
      if (isCurrent()) {
        setState(null);
        callbacks.current.onVisibilityChange?.(false);
      }
    } catch (failure) {
      if (isCurrent()) setError(S.closeFailed);
      throw failure;
    } finally {
      if (isCurrent()) {
        busy.current = null;
        setOperation(null);
      }
    }
  }

  function trackOwner(owner: BrowserWorkspaceScope) {
    if (!registrations.current.has(owner))
      registrations.current.set(
        owner,
        guard.register(
          () => closeOwner(owner),
          async () => {
            await owner.setVisible(false);
            if (mounted.current && scope.current === owner)
              callbacks.current.onVisibilityChange?.(false);
          },
        ),
      );
    return registrations.current.get(owner)!;
  }

  function requestOwnerClose(owner = scope.current) {
    if (owner) registrations.current.get(owner)?.requestClose();
  }

  useLayoutEffect(() => {
    mounted.current = true;
    const predecessor = scope.current ?? undefined;
    const owner = new BrowserWorkspaceScope(client, taskKey, predecessor);
    scope.current = owner;
    let live = true;
    let unlisten: (() => void) | undefined;
    ++sequence.current;
    busy.current = null;
    setAddress("");
    localFile.current = null;
    choiceOwner.current = null;
    setState(null);
    setSnapshot(null);
    setOperation(null);
    setError("");
    setAddressError(false);
    setClearPrompt(null);
    setStorageNotice("");
    setListening(false);

    {
      // Inactive tasks still observe the real page and cancellation receipts.
      void client
        .listenState((next) => {
          const current = scope.current;
          if (!live || !current || !current.accept(next)) return;
          setState(current.current);
          if (next.phase === "closed") {
            registrations.current.get(current)?.release();
            registrations.current.delete(current);
            callbacks.current.onVisibilityChange?.(false);
          }
          setAddress(next.localFileName !== undefined ? "" : next.url);
          setSnapshot((previous) =>
            previous?.label === next.label &&
            previous.revision === next.revision &&
            next.phase === "ready"
              ? previous
              : null,
          );
        })
        .then(
          (stop) => {
            if (live) {
              unlisten = stop;
              setListening(true);
            } else {
              stop();
            }
          },
          () => {
            if (live) setError(S.listenFailed);
          },
        );
    }

    return () => {
      live = false;
      ++sequence.current;
      unlisten?.();
      mounted.current = false;
      // Registered owners include in-flight open and remain available for the
      // global retry if this pane is unmounted before its close acknowledges.
      for (const registration of [...registrations.current.values()])
        registration.requestClose();
    };
  }, [taskKey, projectDirectory, client, guard]);

  function publish(owner: BrowserWorkspaceScope) {
    if (scope.current === owner && !owner.isRetired) setState(owner.current);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await navigateAddress(address);
  }

  async function navigateAddress(target: string) {
    const url = publicBrowserUrl(target);
    if (!url) {
      setAddressError(true);
      return;
    }
    await openTarget({ url });
  }

  async function openTarget(target: { url: string } | { file: VerifiedFile }) {
    const owner = scope.current;
    if (
      !active ||
      !visible ||
      !guard.canOpen ||
      !listening ||
      busy.current ||
      !owner
    )
      return;
    const html = "file" in target ? target.file : null;
    if (html && !projectDirectory) {
      setError(S.htmlProjectMissing);
      return;
    }
    if (html && !/\.html?$/i.test(html.name)) {
      setError(S.htmlFailed);
      return;
    }
    const bounds = surface.current
      ? browserWorkspaceBounds(surface.current.getBoundingClientRect())
      : null;
    if (!bounds) {
      setError(S.boundsMissing);
      return;
    }
    const hasPage = owner.current && owner.current.phase !== "closed";
    const replacePage = !!html || owner.current?.localFileName !== undefined;
    const nextOperation = hasPage && !replacePage ? "navigate" : "open";
    const nextOwner =
      owner.isRetired ||
      owner.current?.phase === "closed" ||
      (hasPage && replacePage)
        ? new BrowserWorkspaceScope(client, taskKey, owner)
        : owner;
    scope.current = nextOwner;
    trackOwner(nextOwner);
    // A late native creation must still have a reserved, visible footprint.
    callbacks.current.onVisibilityChange?.(true);
    const request = ++sequence.current;
    busy.current = nextOperation;
    setOperation(nextOperation);
    setAddressError(false);
    setError("");
    setClearPrompt(null);
    setStorageNotice("");
    setSnapshot(null);
    try {
      if (html) await nextOwner.openHtml(html, bounds, projectDirectory!);
      else if ("url" in target) {
        if (hasPage && !replacePage && !owner.isRetired)
          await nextOwner.navigate(target.url);
        else await nextOwner.open(target.url, bounds);
      }
      if (request === sequence.current && scope.current === nextOwner) {
        if (nextOwner !== owner) {
          registrations.current.get(owner)?.release();
          registrations.current.delete(owner);
        }
        localFile.current = html;
        setAddress("url" in target ? target.url : "");
        publish(nextOwner);
        if (!hasPage) callbacks.current.onVisibilityChange?.(true);
      }
    } catch (failure) {
      if (request === sequence.current) {
        if (!(failure instanceof BrowserWorkspaceRetiredError)) {
          if (nextOperation === "open" && !nextOwner.current) {
            // The backend returns identity for every reserved owner, even a
            // failed creation. A rejected unreserved open can safely retire;
            // a predecessor still requires its own real close confirmation.
            try {
              await closeOwner(nextOwner);
            } catch {
              requestOwnerClose();
              return;
            }
          }
          if (mounted.current && scope.current === nextOwner)
            setError(html ? S.htmlFailed : S.openFailed);
        }
      }
    } finally {
      if (request === sequence.current) {
        busy.current = null;
        setOperation(null);
      }
    }
  }

  // A native picker is not permission to finish opening after a hide or task switch.
  useLayoutEffect(() => {
    if (!visible && busy.current === "choose") ++sequence.current;
    if (!active || !visible) setClearPrompt(null);
  }, [active, visible]);

  async function selectHtml(reload = false) {
    if (!active || !visible || !listening || !guard.canOpen || busy.current)
      return;
    const existing = reload ? localFile.current : null;
    if (reload && !existing) return;
    const request = ++sequence.current;
    const choice = {};
    choiceOwner.current = choice;
    const current = () =>
      choiceOwner.current === choice &&
      mounted.current &&
      available.current.active &&
      available.current.visible &&
      available.current.taskKey === taskKey &&
      request === sequence.current &&
      guard.canOpen;
    busy.current = "choose";
    setOperation("choose");
    setError("");
    try {
      let file: VerifiedFile;
      if (existing) {
        file = await fileDelivery.inspect(existing.root, existing.path);
      } else {
        const path = await chooseFile({
          title: S.chooseHtml,
          multiple: false,
          directory: false,
          filters: [{ name: "HTML", extensions: ["html", "htm"] }],
        });
        if (!current() || typeof path !== "string") return;
        file = await fileDelivery.inspectSelected(path);
      }
      if (!current()) return;
      busy.current = null;
      setOperation(null);
      await openTarget({ file });
    } catch {
      if (current()) setError(S.htmlFailed);
    } finally {
      if (
        mounted.current &&
        available.current.taskKey === taskKey &&
        choiceOwner.current === choice &&
        busy.current === "choose"
      ) {
        choiceOwner.current = null;
        busy.current = null;
        setOperation(null);
      }
    }
  }

  useEffect(() => {
    if (!htmlRequest || consumedHtml.current === htmlRequest) return;
    if (!active || !visible || htmlRequest.taskKey !== taskKey) {
      consumedHtml.current = htmlRequest;
      onHtmlRequestConsumed?.();
      return;
    }
    if (!listening || busy.current) return;
    consumedHtml.current = htmlRequest;
    onHtmlRequestConsumed?.();
    void openTarget({ file: htmlRequest.file });
  }, [htmlRequest, active, visible, taskKey, listening, operation]);

  async function openInBrowser() {
    const owner = scope.current;
    const file = localFile.current;
    if (
      !active ||
      !visible ||
      !guard.canOpen ||
      busy.current ||
      !file ||
      !owner ||
      owner.isRetired ||
      owner.current?.localFileName === undefined
    )
      return;
    const request = ++sequence.current;
    busy.current = "external";
    setOperation("external");
    setError("");
    try {
      // The system opener revalidates this exact receipt. A changed disk file
      // is never silently substituted for the document currently in view.
      await fileDelivery.open(file);
    } catch {
      if (
        mounted.current &&
        request === sequence.current &&
        scope.current === owner
      )
        setError(S.externalOpenFailed);
    } finally {
      if (
        mounted.current &&
        request === sequence.current &&
        scope.current === owner
      ) {
        busy.current = null;
        setOperation(null);
      }
    }
  }

  async function clearHtmlStorage() {
    const owner = scope.current;
    if (
      !owner ||
      clearChoice.current !== owner ||
      owner.isRetired ||
      !available.current.active ||
      !available.current.visible ||
      available.current.taskKey !== taskKey ||
      !guard.canOpen ||
      busy.current ||
      owner.current?.localFileName === undefined ||
      owner.current.localStoragePersistent !== true
    )
      return;
    const request = ++sequence.current;
    const current = () =>
      mounted.current &&
      scope.current === owner &&
      available.current.taskKey === taskKey &&
      request === sequence.current;
    const present = () =>
      current() && available.current.active && available.current.visible;
    busy.current = "clear";
    setOperation("clear");
    setClearPrompt(null);
    setStorageNotice("");
    setError("");
    try {
      await owner.clearHtmlStorage();
      registrations.current.get(owner)?.release();
      registrations.current.delete(owner);
      if (current()) {
        setState(null);
        localFile.current = null;
        callbacks.current.onVisibilityChange?.(false);
        if (present()) setStorageNotice(S.storageCleared);
      }
    } catch {
      // A failed deletion may have already closed the page. Confirm closure
      // independently; never turn a close receipt into a clear-success message.
      try {
        await owner.close();
        registrations.current.get(owner)?.release();
        registrations.current.delete(owner);
        if (current()) {
          setState(null);
          localFile.current = null;
          callbacks.current.onVisibilityChange?.(false);
        }
      } catch {
        requestOwnerClose(owner);
      }
      if (present()) setError(S.clearStorageFailed);
    } finally {
      if (current()) {
        busy.current = null;
        setOperation(null);
      }
    }
  }

  async function readSnapshot() {
    const owner = scope.current;
    if (
      !active ||
      !visible ||
      guard.getSnapshot().blocked ||
      busy.current ||
      !owner ||
      owner.current?.phase !== "ready" ||
      owner.current.localFileName !== undefined
    )
      return;
    const request = ++sequence.current;
    busy.current = "snapshot";
    setOperation("snapshot");
    setError("");
    setSnapshot(null);
    try {
      const result = await owner.snapshot();
      if (
        request === sequence.current &&
        scope.current === owner &&
        !owner.isRetired &&
        owner.current?.phase === "ready" &&
        owner.current.label === result.label &&
        owner.current.revision === result.revision
      ) {
        setSnapshot(result);
      }
    } catch (failure) {
      if (request === sequence.current) {
        setError(
          failure instanceof BrowserWorkspaceRetiredError
            ? S.readChanged
            : S.readFailed,
        );
      }
    } finally {
      if (request === sequence.current) {
        busy.current = null;
        setOperation(null);
      }
    }
  }

  function closePage() {
    if (busy.current === "close" || busy.current === "clear") return;
    if (guard.getSnapshot().failed) guard.retry();
    else requestOwnerClose();
  }

  // The first render of another task must never display the previous task's data.
  const belongsToTask = scope.current?.taskKey === taskKey;
  const visibleState =
    belongsToTask && state?.taskKey === taskKey ? state : null;
  const visibleSnapshot =
    belongsToTask && snapshot?.taskKey === taskKey ? snapshot : null;
  const visibleAddress = belongsToTask ? address : "";
  const hasPage = !!visibleState && visibleState.phase !== "closed";
  const isLocal = visibleState?.localFileName !== undefined;

  useEffect(() => {
    // Explicit projection omits backend diagnostics and any snapshot body.
    callbacks.current.onStateChange?.(
      visibleState
        ? {
            taskKey: visibleState.taskKey,
            label: visibleState.label,
            url: visibleState.url,
            phase: visibleState.phase,
            revision: visibleState.revision,
            ...(visibleState.localFileName !== undefined
              ? {
                  localFileName: visibleState.localFileName,
                  ...(visibleState.localStoragePersistent !== undefined
                    ? {
                        localStoragePersistent:
                          visibleState.localStoragePersistent,
                      }
                    : {}),
                }
              : {}),
          }
        : null,
    );
  }, [visibleState]);

  useLayoutEffect(() => {
    const owner = scope.current;
    if (!owner || owner.isRetired || (active && visible && blocked)) return;
    let cancelled = false;
    const showing = active && visible;
    if (showing && (owner.current || busy.current === "open")) {
      if (!trackOwner(owner).reveal()) return;
      // Showing can succeed before IPC returns; reserve layout before sending.
      callbacks.current.onVisibilityChange?.(true);
    }
    const bounds =
      showing && surface.current
        ? browserWorkspaceBounds(surface.current.getBoundingClientRect())
        : null;
    void owner.setVisible(showing, bounds ?? undefined).then(
      () => {
        if (!cancelled && scope.current === owner && !owner.isRetired) {
          // A mount-time no-page check must not release a later in-flight open.
          if (owner.current || busy.current !== "open") {
            callbacks.current.onVisibilityChange?.(showing && !!owner.current);
          }
        }
      },
      () => {
        if (scope.current !== owner || busy.current === "clear") return;
        if (mounted.current) setError(S.visibilityFailed);
        // Retain the owner and the old footprint until actual close confirms.
        requestOwnerClose();
      },
    );
    return () => {
      cancelled = true;
    };
  }, [
    active,
    visible,
    hasPage,
    visibleState?.label,
    guard,
    blocked,
    guardRevision,
  ]);

  useEffect(() => {
    if (!active || !visible || !hasPage || blocked) return;
    const owner = scope.current;
    if (!owner || owner.isRetired) return;
    let cancelled = false;
    let frame = 0;
    let last: BrowserWorkspaceBounds | null = null;
    let resizing = false;

    // ResizeObserver alone misses a pane that moves without changing its size.
    // Read once per frame while a native child exists; send only changed bounds.
    const synchronize = () => {
      if (cancelled || owner.isRetired || scope.current !== owner) return;
      const bounds = surface.current
        ? browserWorkspaceBounds(surface.current.getBoundingClientRect())
        : null;
      if (!bounds) {
        setSnapshot(null);
        void closeOwner(owner).then(
          () => {
            if (!cancelled && scope.current === owner) setState(null);
          },
          () => {
            if (!cancelled && scope.current === owner) setError(S.closeFailed);
            requestOwnerClose();
          },
        );
        return;
      }
      if (!resizing && (!last || !sameBounds(last, bounds))) {
        resizing = true;
        void owner
          .resize(bounds)
          .then(
            () => {
              last = bounds;
            },
            () => {
              if (cancelled || owner.isRetired || scope.current !== owner)
                return;
              setSnapshot(null);
              void closeOwner(owner).then(
                () => {
                  if (!cancelled && scope.current === owner) {
                    setState(null);
                    setError(S.resizeFailed);
                  }
                },
                () => {
                  if (!cancelled && scope.current === owner)
                    setError(S.closeFailed);
                  requestOwnerClose();
                },
              );
            },
          )
          .finally(() => {
            resizing = false;
          });
      }
      frame = requestAnimationFrame(synchronize);
    };
    frame = requestAnimationFrame(synchronize);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [active, visible, hasPage, visibleState?.label, blocked]);

  if (!active) return null;

  return (
    <section className="browser-workspace" aria-label={S.title}>
      <div className="browser-workspace-controls">
        {isLocal ? (
          <div className="browser-workspace-address-row">
            <button
              type="button"
              className="browser-workspace-icon"
              title={S.reloadHtml}
              aria-label={S.reloadHtml}
              disabled={operation !== null || blocked || !visible}
              onClick={() => void selectHtml(true)}
            >
              <ArrowClockwiseIcon size={17} aria-hidden="true" />
            </button>
            <div className="browser-workspace-address-box browser-workspace-local-file">
              <FileHtmlIcon size={16} aria-hidden="true" />
              <span title={visibleState.localFileName}>
                {visibleState.localFileName}
              </span>
            </div>
            <button
              type="button"
              className="browser-workspace-external"
              title={S.openInBrowser}
              disabled={
                operation !== null || blocked || !visible || !localFile.current
              }
              onClick={() => void openInBrowser()}
            >
              <ArrowSquareOutIcon size={15} aria-hidden="true" />
              <span>{S.openInBrowser}</span>
            </button>
            <button
              type="button"
              className="browser-workspace-icon"
              title={S.closeHtml}
              aria-label={
                guard.getSnapshot().failed ? S.retryClose : S.closeHtml
              }
              disabled={operation === "close" || operation === "clear"}
              onClick={closePage}
            >
              <XIcon size={17} aria-hidden="true" />
            </button>
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)} noValidate>
            <label className="browser-workspace-sr-only" htmlFor={addressId}>
              {S.address}
            </label>
            <div className="browser-workspace-address-row">
              <button
                type="button"
                className="browser-workspace-icon"
                title={S.reload}
                aria-label={S.reload}
                onClick={() =>
                  visibleState?.url && void navigateAddress(visibleState.url)
                }
                disabled={!hasPage || operation !== null || blocked || !visible}
              >
                <ArrowClockwiseIcon size={17} aria-hidden="true" />
              </button>
              <div className="browser-workspace-address-box">
                <GlobeIcon size={15} aria-hidden="true" />
                <input
                  id={addressId}
                  type="url"
                  value={visibleAddress}
                  onChange={(event) => {
                    setAddress(event.target.value);
                    setAddressError(false);
                  }}
                  placeholder={S.addressPlaceholder}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-invalid={addressError || undefined}
                  aria-describedby={addressError ? errorId : hintId}
                  disabled={operation !== null || !visible}
                />
              </div>
              <button
                type="submit"
                className="browser-workspace-icon"
                title={hasPage ? S.navigate : S.open}
                aria-label={hasPage ? S.navigate : S.open}
                disabled={
                  operation !== null ||
                  blocked ||
                  !listening ||
                  !visibleAddress.trim() ||
                  !visible
                }
              >
                <ArrowRightIcon size={17} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="browser-workspace-icon"
                onClick={() => void readSnapshot()}
                title={operation === "snapshot" ? S.reading : S.read}
                aria-label={operation === "snapshot" ? S.reading : S.read}
                disabled={
                  operation !== null ||
                  blocked ||
                  visibleState?.phase !== "ready" ||
                  scope.current?.isRetired ||
                  !visible
                }
              >
                <TextAlignLeftIcon size={17} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="browser-workspace-icon"
                onClick={closePage}
                title={
                  operation === "close"
                    ? S.closing
                    : guard.getSnapshot().failed
                      ? S.retryClose
                      : S.close
                }
                aria-label={
                  operation === "close"
                    ? S.closing
                    : guard.getSnapshot().failed
                      ? S.retryClose
                      : S.close
                }
                disabled={
                  operation === "close" ||
                  (!hasPage &&
                    operation !== "open" &&
                    !scope.current?.isRetired)
                }
              >
                <XIcon size={17} aria-hidden="true" />
              </button>
            </div>
            <p id={hintId} className="browser-workspace-sr-only">
              {S.addressHint}
            </p>
            {addressError && (
              <p id={errorId} className="browser-workspace-error" role="alert">
                {S.invalidAddress}
              </p>
            )}
          </form>
        )}
        <div className="browser-workspace-access-row">
          {isLocal ? (
            <span className="browser-workspace-sharing">{S.localHtml}</span>
          ) : (
            (toolbar ?? (
              <span className="browser-workspace-sharing">{S.notShared}</span>
            ))
          )}
          <div className="browser-workspace-file-actions">
            <button
              type="button"
              onClick={() => void selectHtml()}
              disabled={operation !== null || blocked || !visible || !listening}
            >
              {S.openHtml}
            </button>
            {isLocal ? (
              <button
                type="button"
                onClick={closePage}
                disabled={operation !== null || blocked || !visible}
              >
                {S.openAddress}
              </button>
            ) : (
              <details className="browser-workspace-help">
                <summary>{S.publicPage}</summary>
                <p>{S.scope}</p>
              </details>
            )}
          </div>
        </div>
        {isLocal && (
          <p className="browser-workspace-hint">
            {S.localHint}{" "}
            {visibleState.localStoragePersistent === true
              ? S.localPersistent
              : visibleState.localStoragePersistent === false
                ? S.localTemporary
                : S.localStorageUnknown}
          </p>
        )}
        {isLocal && hasPage && visibleState.localStoragePersistent === true && (
          <div className="browser-workspace-help">
            <button
              type="button"
              aria-expanded={clearConfirmation === scope.current}
              onClick={() => setClearPrompt(scope.current)}
              disabled={operation !== null || blocked || !visible}
            >
              {S.clearStorage}
            </button>
            {clearConfirmation === scope.current && (
              <div>
                <p>{S.clearStorageConfirm(visibleState.localFileName!)}</p>
                <button
                  type="button"
                  onClick={() => void clearHtmlStorage()}
                  disabled={operation !== null || blocked || !visible}
                >
                  {S.clearStorageAction}
                </button>{" "}
                <button type="button" onClick={() => setClearPrompt(null)}>
                  {S.clearStorageCancel}
                </button>
              </div>
            )}
          </div>
        )}
        {(operation === "clear" || storageNotice) && (
          <p
            className="browser-workspace-status"
            role="status"
            aria-live="polite"
          >
            {operation === "clear" ? S.clearingStorage : storageNotice}
          </p>
        )}
        {operation === "choose" && (
          <p className="browser-workspace-status" role="status">
            {S.choosingHtml}
          </p>
        )}
        {(error ||
          operation === "open" ||
          (visibleState && visibleState.phase !== "ready")) && (
          <p
            className={
              error ||
              visibleState?.phase === "blocked" ||
              visibleState?.phase === "error"
                ? "browser-workspace-status browser-workspace-error"
                : "browser-workspace-status"
            }
            role="status"
            aria-live="polite"
          >
            {belongsToTask
              ? error ||
                (operation === "open" ? S.loading : phaseText(visibleState))
              : ""}
          </p>
        )}
      </div>
      <div
        className="browser-workspace-surface"
        ref={surface}
        aria-label={S.title}
      >
        {!hasPage && (
          <div className="browser-workspace-empty">
            <strong>{S.emptyTitle}</strong>
            <p>{S.emptyBody}</p>
          </div>
        )}
      </div>
      {visibleSnapshot && (
        <section
          className="browser-workspace-snapshot"
          aria-label={S.snapshotTitle}
        >
          <header>
            <strong>{S.snapshotTitle}</strong>
            <button
              type="button"
              className="browser-workspace-icon"
              title={S.snapshotClose}
              aria-label={S.snapshotClose}
              onClick={() => setSnapshot(null)}
            >
              <XIcon size={15} aria-hidden="true" />
            </button>
            <time
              dateTime={new Date(visibleSnapshot.observedAtMs).toISOString()}
            >
              {S.observedAt(
                new Date(visibleSnapshot.observedAtMs).toLocaleTimeString(),
              )}
            </time>
          </header>
          <p className="browser-workspace-hint">{S.snapshotNote}</p>
          {visibleSnapshot.title && <h3>{visibleSnapshot.title}</h3>}
          <pre>{visibleSnapshot.text || S.snapshotEmpty}</pre>
        </section>
      )}
    </section>
  );
}
