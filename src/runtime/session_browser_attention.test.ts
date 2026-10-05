import { expect, it, vi } from "vitest";
import { browserSharingAttention } from "./browser_sharing_attention";
import { observeBrowserDesktopNotification } from "./desktop_notifications";
import { observeBrowserRequests } from "./session_browser_attention";
import { freshThreadState } from "./session_projection";

vi.mock("./desktop_notifications", () => ({
  observeBrowserDesktopNotification: vi.fn(),
}));

it("observes actual browser pending state and invalidates the reminder when its owner withdraws", () => {
  const state = freshThreadState(
    "browser-attention-test",
    "agent",
    "/work",
    "native",
  );
  state.connectionId = "connection";
  const owner = {};
  const changed = vi.fn();
  const observer = vi.mocked(observeBrowserDesktopNotification);
  observer.mockClear();
  const stop = observeBrowserRequests(
    (key) => (key === state.key ? state : undefined),
    changed,
  );
  try {
    browserSharingAttention.update(owner, state.key, "pending");
    expect(state.browserReadRequestId).toBe("pending");
    expect(observer).toHaveBeenCalledTimes(1);
    const [observed, request, current] = observer.mock.calls[0];
    expect(observed).toBe(state);
    expect(request).toBe("pending");
    expect(current()).toBe(true);
    browserSharingAttention.update(owner, state.key, "pending");
    expect(observer).toHaveBeenCalledTimes(1);
    browserSharingAttention.release(owner, state.key);
    expect(state.browserReadRequestId).toBeNull();
    expect(current()).toBe(false);
    expect(observer).toHaveBeenCalledTimes(1);
    state.connectionLost = true;
    browserSharingAttention.update(owner, state.key, "after-disconnect");
    expect(observer).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(2);
  } finally {
    browserSharingAttention.release(owner, state.key);
    stop();
  }
});
