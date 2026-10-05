import { beforeEach, expect, it, vi } from "vitest";
import type { AgentAccessPrimary } from "./access_primary";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as { deps?: unknown[]; cleanup?: () => void }[],
  pending: [] as (() => void)[],
}));
vi.mock("react", () => ({
  useRef: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.slots)) h.slots[index] = { current: initial };
    return h.slots[index];
  },
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
    const index = h.cursor++,
      previous = h.effects[index];
    if (
      !previous ||
      !deps ||
      deps.some((value, i) => !Object.is(value, previous.deps?.[i]))
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
import { useAccessPrimary } from "./access_primary";
const receive = vi.fn();
function render(action: AgentAccessPrimary | null) {
  h.cursor = 0;
  useAccessPrimary(action, receive);
  for (const effect of h.pending.splice(0)) effect();
}
const action = (
  id: string,
  run = vi.fn(),
  disabled = false,
): AgentAccessPrimary => ({ id, label: "继续", run, disabled });
beforeEach(() => {
  h.slots = [];
  h.effects = [];
  h.pending = [];
  vi.clearAllMocks();
});

it("keeps the footer on the latest form values for the same action owner", () => {
  const before = action("owner"),
    after = action("owner");
  render(before);
  const footer = receive.mock.calls.at(-1)![0] as AgentAccessPrimary;
  render(after);
  footer.run();
  expect(before.run).not.toHaveBeenCalled();
  expect(after.run).toHaveBeenCalledOnce();
});
it.each(["changed", "disabled", "cleared"])(
  "rejects an old footer after its action is %s",
  (cause) => {
    const before = action("old");
    render(before);
    const old = receive.mock.calls.at(-1)![0] as AgentAccessPrimary;
    const after =
      cause === "cleared"
        ? null
        : action(
            cause === "changed" ? "new" : "old",
            vi.fn(),
            cause === "disabled",
          );
    render(after);
    old.run();
    expect(before.run).not.toHaveBeenCalled();
    if (after) expect(after.run).not.toHaveBeenCalled();
  },
);
