import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: h.open }));
import { inquiryUrl, readElicitation, replyToElicitation } from "./elicitation";
import { AuthActivity } from "./auth_activity";

const pending = () =>
  readElicitation({
    kind: "elicitation",
    requestId: "r",
    mode: "url",
    url: "https://example.test/auth",
    message: "Review",
    owner: { connectionId: "c", requestId: 1 },
    request: { _meta: { future: null } },
  })!;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  h.invoke.mockReset().mockResolvedValue({ status: "submitted" });
  h.open.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

it("reading or rendering the inquiry performs no open, invoke or prefetch", () => {
  const p = pending();
  expect(p.requestSnapshot).toEqual({ _meta: { future: null } });
  expect(h.invoke).not.toHaveBeenCalled();
  expect(h.open).not.toHaveBeenCalled();
});

it.each([
  "file:///private/secret",
  "javascript:alert(1)",
  "data:text/html,x",
  "http://localhost/",
  "custom://auth",
  "https://user:password@example.test/",
  "https://example.test/\n",
  "https://example.test\\other",
  "https://example.test/\u0085",
])("rejects a non-approved URL shape: %s", (url) =>
  expect(inquiryUrl(url)).toBeNull(),
);

it("requires an explicit accept, then distinguishes opener delivery and waiting for completion", async () => {
  const p = pending();
  const remove = vi.fn();
  const opened = deferred<void>();
  h.open.mockReturnValue(opened.promise);
  const run = replyToElicitation(p, "accept", undefined, {
    current: () => true,
    changed: () => {},
    remove,
  });
  expect(p.opening).toBe(true);
  expect(h.invoke).not.toHaveBeenCalled();
  opened.resolve();
  await run;
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith(
    "session_elicitation_respond",
    {
      requestId: "r",
      sessionId: null,
      requestOwner: { connectionId: "c", requestId: 1 },
      action: "accept",
      content: null,
    },
  );
  expect(p.handoff).toBe("waiting");
  expect(remove).not.toHaveBeenCalled();
  await replyToElicitation(p, "accept", undefined, {
    current: () => true,
    changed: () => {},
    remove,
  });
  expect(h.open).toHaveBeenCalledTimes(1);
  expect(h.invoke).toHaveBeenCalledTimes(1);
});

it("an opener failure does not send accept and lets the user choose again", async () => {
  const p = pending();
  h.open.mockRejectedValue(new Error("controlled failure"));
  await replyToElicitation(p, "accept", undefined, {
    current: () => true,
    changed: () => {},
    remove: () => {},
  });
  expect(p.status).toBe("pending");
  expect(p.error).toBeTruthy();
  expect(h.invoke).not.toHaveBeenCalled();
});

it("an expired or cancelled inquiry cannot accept after a late opener result", async () => {
  const p = pending();
  const opened = deferred<void>();
  h.open.mockReturnValue(opened.promise);
  let current = true;
  const run = replyToElicitation(p, "accept", undefined, {
    current: () => current,
    changed: () => {},
    remove: () => {},
  });
  current = false;
  opened.resolve();
  await run;
  expect(h.invoke).not.toHaveBeenCalled();
});

it("cancel during an outstanding opener sends one cancel and never a later accept", async () => {
  const p = pending();
  const opened = deferred<void>();
  h.open.mockReturnValue(opened.promise);
  let current = true;
  const ports = {
    current: () => current,
    changed: () => {},
    remove: () => {
      current = false;
    },
  };
  const run = replyToElicitation(p, "accept", undefined, ports);
  await replyToElicitation(p, "cancel", undefined, ports);
  opened.resolve();
  await run;
  expect(h.invoke).toHaveBeenCalledTimes(1);
  expect(h.invoke.mock.calls[0][1].action).toBe("cancel");
});

it("an opener timeout remains unknown and its late success cannot submit a response", async () => {
  vi.useFakeTimers();
  const p = pending();
  const opened = deferred<void>();
  h.open.mockReturnValue(opened.promise);
  const ports = { current: () => true, changed: () => {}, remove: () => {} };
  const run = replyToElicitation(p, "accept", undefined, ports);
  await vi.advanceTimersByTimeAsync(15_000);
  await run;
  expect(p.status).toBe("uncertain");
  opened.resolve();
  await Promise.resolve();
  await replyToElicitation(p, "accept", undefined, ports);
  expect(h.invoke).not.toHaveBeenCalled();
  expect(h.open).toHaveBeenCalledTimes(1);
});

it("a lost response receipt cannot cause an automatic duplicate or fake completion", async () => {
  const p = pending();
  h.invoke.mockRejectedValue(new Error("controlled IPC failure"));
  const ports = { current: () => true, changed: () => {}, remove: vi.fn() };
  await replyToElicitation(p, "accept", undefined, ports);
  expect(p.status).toBe("uncertain");
  expect(p.handoff).toBeUndefined();
  await replyToElicitation(p, "accept", undefined, ports);
  expect(h.invoke).toHaveBeenCalledTimes(1);
  expect(h.open).toHaveBeenCalledTimes(1);
});

it("external completion before consent is not authentication success", async () => {
  const activity = new AuthActivity();
  const finish = deferred<unknown>();
  activity.begin(
    { agentId: "fixture", cwd: "/controlled" },
    {
      kind: "authentication",
      methodId: "fixture",
      title: "Fixture",
      completion: "exit_code",
    },
    "attempt",
  );
  const run = activity.protocol({
    run: () => finish.promise,
    cancel: async () => {},
    reconnect: async () => {},
  });
  activity.inquiryEvent("attempt", {
    kind: "elicitation",
    requestId: "r",
    mode: "url",
    url: "https://example.test/auth",
  });
  activity.inquiryEvent("attempt", {
    kind: "elicitationComplete",
    requestId: "r",
  });
  expect(activity.getSnapshot()?.inquiries).toEqual([]);
  expect(activity.getSnapshot()?.operationConfirmed).toBe(false);
  expect(activity.getSnapshot()?.phase).toBe("waiting");
  finish.reject(new Error("controlled parent failure"));
  await run;
  expect(activity.getSnapshot()?.phase).toBe("failed");
  expect(h.open).not.toHaveBeenCalled();
  expect(h.invoke).not.toHaveBeenCalled();
});
