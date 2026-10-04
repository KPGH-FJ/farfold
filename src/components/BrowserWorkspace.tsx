import { browserSurfaceGuard } from "../runtime/browser_surface";
import type { BrowserSurfaceGuard } from "../runtime/browser_surface_guard";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
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
import { BROWSER_WORKSPACE_STRINGS as S } from "../runtime/browser_workspace_strings";
import "../browser-workspace.css";

export interface BrowserWorkspaceProps {
  /** Trusted current conversation key, never a key supplied by a remote page. */
  taskKey: string;
  /** False for hidden routes/tabs and for any overlay covering the native surface. */
  active: boolean;
  /** Keep this object stable. Create one at the app's trusted composition boundary. */
  client: BrowserWorkspaceClient;
  /** The application coordinator retains failed closure outside hidden panes. */
  guard?: BrowserSurfaceGuard;
}

type Operation = "open" | "navigate" | "snapshot" | "close" | null;

function phaseText(state: BrowserWorkspaceState | null): string {
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
  active,
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
  const registrations = useRef(new Map<BrowserWorkspaceScope, () => void>());
  const [address, setAddress] = useState("");
  const [state, setState] = useState<BrowserWorkspaceState | null>(null);
  const [snapshot, setSnapshot] = useState<BrowserWorkspaceSnapshot | null>(
    null,
  );
  const [operation, setOperation] = useState<Operation>(null);
  const [error, setError] = useState("");
  const [addressError, setAddressError] = useState(false);
  const [listening, setListening] = useState(false);
  const [blocked, setBlocked] = useState(guard.getSnapshot().blocked);
  useEffect(
    () => guard.subscribe(() => setBlocked(guard.getSnapshot().blocked)),
    [guard],
  );

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
      registrations.current.get(owner)?.();
      registrations.current.delete(owner);
      if (isCurrent()) setState(null);
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
        guard.register(() => closeOwner(owner)),
      );
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
    setState(null);
    setSnapshot(null);
    setOperation(null);
    setError("");
    setAddressError(false);
    setListening(false);

    if (active) {
      void client
        .listenState((next) => {
          const current = scope.current;
          if (!live || !current || !current.accept(next)) return;
          setState(current.current);
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
      guard.requestClose();
    };
  }, [taskKey, active, client, guard]);

  function publish(owner: BrowserWorkspaceScope) {
    if (scope.current === owner && !owner.isRetired) setState(owner.current);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const owner = scope.current;
    if (!active || !guard.canOpen || !listening || busy.current || !owner)
      return;
    const url = publicBrowserUrl(address);
    if (!url) {
      setAddressError(true);
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
    const nextOperation = hasPage ? "navigate" : "open";
    const nextOwner =
      owner.isRetired || owner.current?.phase === "closed"
        ? new BrowserWorkspaceScope(client, taskKey, owner)
        : owner;
    scope.current = nextOwner;
    trackOwner(nextOwner);
    const request = ++sequence.current;
    busy.current = nextOperation;
    setOperation(nextOperation);
    setAddressError(false);
    setError("");
    setSnapshot(null);
    try {
      if (hasPage && !owner.isRetired) await nextOwner.navigate(url);
      else await nextOwner.open(url, bounds);
      if (request === sequence.current && scope.current === nextOwner) {
        setAddress(url);
        publish(nextOwner);
      }
    } catch (failure) {
      if (request === sequence.current) {
        if (!(failure instanceof BrowserWorkspaceRetiredError)) {
          setError(S.openFailed);
        }
      }
    } finally {
      if (request === sequence.current) {
        busy.current = null;
        setOperation(null);
      }
    }
  }

  async function readSnapshot() {
    const owner = scope.current;
    if (
      !active ||
      guard.getSnapshot().blocked ||
      busy.current ||
      !owner ||
      owner.current?.phase !== "ready"
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
    if (busy.current === "close") return;
    if (guard.getSnapshot().failed) guard.retry();
    else guard.requestClose();
  }

  // The first render of another task must never display the previous task's data.
  const belongsToTask = scope.current?.taskKey === taskKey;
  const visibleState =
    belongsToTask && state?.taskKey === taskKey ? state : null;
  const visibleSnapshot =
    belongsToTask && snapshot?.taskKey === taskKey ? snapshot : null;
  const visibleAddress = belongsToTask ? address : "";
  const hasPage = !!visibleState && visibleState.phase !== "closed";

  useEffect(() => {
    if (!active || !hasPage) return;
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
            guard.requestClose();
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
                  guard.requestClose();
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
  }, [active, hasPage, visibleState?.label]);

  if (!active) return null;

  return (
    <section className="browser-workspace" aria-label={S.title}>
      <header className="browser-workspace-heading">
        <strong>{S.title}</strong>
        <span className="browser-workspace-sharing">{S.notShared}</span>
      </header>
      <div className="browser-workspace-controls">
        <p className="browser-workspace-scope">{S.scope}</p>
        <form onSubmit={(event) => void submit(event)} noValidate>
          <label htmlFor={addressId}>{S.address}</label>
          <div className="browser-workspace-address-row">
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
              disabled={operation !== null}
            />
            <button
              type="submit"
              className="browser-workspace-primary"
              disabled={
                operation !== null ||
                blocked ||
                !listening ||
                !visibleAddress.trim()
              }
            >
              {hasPage ? S.navigate : S.open}
            </button>
          </div>
          <p
            id={addressError ? errorId : hintId}
            className={
              addressError
                ? "browser-workspace-error"
                : "browser-workspace-hint"
            }
            role={addressError ? "alert" : undefined}
          >
            {addressError ? S.invalidAddress : S.addressHint}
          </p>
        </form>
        <div className="browser-workspace-actions">
          <button
            type="button"
            onClick={() => void readSnapshot()}
            disabled={
              operation !== null ||
              blocked ||
              visibleState?.phase !== "ready" ||
              scope.current?.isRetired
            }
          >
            {operation === "snapshot" ? S.reading : S.read}
          </button>
          <button
            type="button"
            onClick={() => void closePage()}
            disabled={
              operation === "close" ||
              (!hasPage && operation !== "open" && !scope.current?.isRetired)
            }
          >
            {operation === "close"
              ? S.closing
              : guard.getSnapshot().failed
                ? S.retryClose
                : S.close}
          </button>
        </div>
        {visibleState?.url && (
          <p className="browser-workspace-location" title={visibleState.url}>
            <span>{S.currentAddress}</span> <bdi>{visibleState.url}</bdi>
          </p>
        )}
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
