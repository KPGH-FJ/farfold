import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  cursor: 0,
  effectCursor: 0,
  refs: [] as { current: unknown }[],
  effects: [] as { deps: unknown[]; cleanup?: () => void }[],
  pending: [] as (() => void)[],
  host: { replaceChildren: vi.fn() },
  created: vi.fn(),
  focus: vi.fn(),
  write: vi.fn(),
  writeln: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (initial: unknown) => {
    const index = h.cursor++;
    return (h.refs[index] ??= { current: index === 0 ? h.host : initial });
  },
  useState: () => [null, vi.fn()],
  useEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
    const index = h.effectCursor++,
      previous = h.effects[index];
    if (
      !previous ||
      deps.some((value, i) => !Object.is(value, previous.deps[i]))
    ) {
      const next = { deps } as typeof previous;
      h.effects[index] = next;
      h.pending.push(() => {
        previous?.cleanup?.();
        next.cleanup = effect() || undefined;
      });
    }
  },
}));
vi.mock("../runtime/agents", () => ({
  ptyResize: vi.fn(async () => {}),
  ptyWrite: vi.fn(async () => {}),
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    constructor() {
      h.created();
    }
    loadAddon() {}
    open() {}
    write = h.write;
    writeln = h.writeln;
    focus = h.focus;
    dispose = h.dispose;
    onData() {
      return { dispose: vi.fn() };
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

import { InlineTerminal } from "./InlineTerminal";
import { BufferedLoginTerminal } from "../runtime/login_terminal";
import { AUTH_ACTIVITY_STRINGS as S } from "../runtime/auth_strings";

function render(
  session: BufferedLoginTerminal,
  getFinishRequested: () => boolean,
  purpose: "authentication" | "service_configuration" = "authentication",
) {
  h.cursor = h.effectCursor = 0;
  InlineTerminal({ session, getFinishRequested, purpose });
  for (const effect of h.pending.splice(0)) effect();
}
beforeEach(() => {
  h.refs = [];
  h.effects = [];
  h.pending = [];
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  for (const effect of h.effects) effect.cleanup?.();
  vi.unstubAllGlobals();
});

it.each(["authentication", "service_configuration"] as const)(
  "uses the current finish intent for a nonzero %s exit without recreating or refocusing the terminal",
  async (purpose) => {
    const session = new BufferedLoginTerminal({
      start: async () => "owned",
      wait: () => new Promise(() => {}),
      close: async () => 130,
      exit: vi.fn(),
    });
    await session.start();
    render(session, () => false, purpose);
    await vi.waitFor(() => expect(h.focus).toHaveBeenCalledOnce());
    let requested = false;
    render(session, () => requested, purpose);
    expect(h.created).toHaveBeenCalledOnce();
    expect(h.focus).toHaveBeenCalledOnce();
    requested = true;
    // The exit frame arrives synchronously before another React render.
    await session.close();
    expect(h.writeln).toHaveBeenCalledExactlyOnceWith(`\r\n${S.finishEnded}`);
    expect(session.getSnapshot()).toMatchObject({ exit: 130, cancelled: true });
    expect(h.created).toHaveBeenCalledOnce();
    expect(h.focus).toHaveBeenCalledOnce();
  },
);

it("keeps a plain cancellation distinct when no finish intent belongs to this terminal", async () => {
  const session = new BufferedLoginTerminal({
    start: async () => "owned",
    wait: () => new Promise(() => {}),
    close: async () => 130,
    exit: vi.fn(),
  });
  await session.start();
  render(session, () => false);
  await vi.waitFor(() => expect(h.focus).toHaveBeenCalledOnce());
  await session.close();
  expect(h.writeln).toHaveBeenCalledExactlyOnceWith(`\r\n${S.cancelled}`);
});
