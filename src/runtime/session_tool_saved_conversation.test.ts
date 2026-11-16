import { afterEach, expect, it, vi } from "vitest";
import {
  changeFixture,
  changeInput,
  changed,
  changeOperation,
  inspected,
} from "./session_tool_change.test-support";
import { flush } from "./session_tools.test-support";

afterEach(() => vi.useRealTimers());

it("keeps an empty conversation after its baseline is saved while a tool change remains unknown", async () => {
  const h = changeFixture();
  h.owner.configError = "keep independent failure";
  h.controller.start(changeInput);
  await flush();
  h.start.resolve({ ...changeOperation(h.request()), conversationSaved: true });
  await flush();
  expect(h.owner.identity).toBe("established");
  expect(h.owner.configuring).toBe(true);
  expect(h.owner.configError).toBe("keep independent failure");
  expect(h.controller.getSnapshot().unresolved).toBe(true);
});

it("promotes a saved empty conversation before releasing its completed mutation gate", async () => {
  const h = changeFixture();
  const observed: string[] = [];
  h.protection.subscribe(() =>
    observed.push(`${h.owner.identity}:${h.owner.configuring}`),
  );
  h.controller.start(changeInput);
  await flush();
  h.start.resolve({ ...changed(h.request()), conversationSaved: true });
  await flush();
  expect(h.owner.identity).toBe("established");
  expect(h.owner.configuring).toBe(false);
  expect(observed).not.toContain("draft:false");
});

it.each([true, undefined])(
  "uses explicit baseline persistence on a rejected mutation (%s)",
  async (saved) => {
    const h = changeFixture();
    h.controller.start(changeInput);
    await flush();
    h.start.reject({
      code: "changed",
      message: "safe",
      notDispatched: true,
      ...(saved ? { conversationSaved: true } : {}),
    });
    await flush();
    expect(h.owner.identity).toBe(saved ? "established" : "draft");
    expect(h.owner.configuring).toBe(false);
  },
);

it("does not turn a read-only inventory response into proof of a saved conversation", async () => {
  const h = changeFixture();
  h.controller.list();
  await flush();
  h.start.resolve({ ...inspected(h.request()), conversationSaved: true });
  await flush();
  expect(h.owner.identity).toBe("draft");
  expect(h.controller.getSnapshot().error).toBe("invalidResponse");
});

it("does not trust persistence from a contradictory completed operation", async () => {
  const h = changeFixture();
  h.controller.start(changeInput);
  await flush();
  h.start.resolve({
    ...changeOperation(h.request()),
    state: "ready",
    settled: true,
    mutationSent: false,
    conversationSaved: true,
  });
  await flush();
  expect(h.controller.getSnapshot().error).toBe("invalidResponse");
  expect(h.owner.identity).toBe("draft");
  expect(h.owner.configuring).toBe(true);
});

it("does not promote a replacement conversation from a late saved response", async () => {
  const h = changeFixture();
  h.controller.start(changeInput);
  await flush();
  const replacement = { ...h.owner };
  h.replace(replacement);
  h.start.resolve({ ...changed(h.request()), conversationSaved: true });
  await flush();
  expect(h.owner.identity).toBe("draft");
  expect(replacement.identity).toBe("draft");
  expect(replacement.configuring).toBe(true);
});

it("does not accept a status error as admission persistence evidence", async () => {
  const h = changeFixture();
  h.controller.start(changeInput);
  await flush();
  h.start.resolve(changeOperation(h.request()));
  await flush();
  h.controller.check();
  await flush();
  h.status.reject({
    code: "changed",
    message: "safe",
    notDispatched: true,
    conversationSaved: true,
  });
  await flush();
  expect(h.owner.identity).toBe("draft");
  expect(h.owner.configuring).toBe(true);
});
