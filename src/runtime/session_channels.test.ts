import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { OwnedSessionChannel, SessionChannels } from "./session_channels";

it("retires exact replaced/deleted/cleared delivery owners once and detaches their callbacks", () => {
  const channels = new SessionChannels();
  const deliveries = [0, 1, 2].map(() => ({ dispose: vi.fn() }));
  const owners = deliveries.map(
    (delivery) => new OwnedSessionChannel(delivery),
  );
  const callbacks = owners.map((owner) => (owner.onmessage = vi.fn()));
  channels.set("a", owners[0]);
  channels.set("a", owners[0]);
  expect(deliveries[0].dispose).not.toHaveBeenCalled();
  channels.set("a", owners[1]);
  expect(deliveries[0].dispose).toHaveBeenCalledTimes(1);
  owners[0].onmessage({ obsolete: true });
  expect(callbacks[0]).not.toHaveBeenCalled();
  expect(channels.get("a")).toBe(owners[1]);
  expect(channels.delete("a")).toBe(true);
  expect(channels.delete("a")).toBe(false);
  expect(deliveries[1].dispose).toHaveBeenCalledTimes(1);
  channels.set("b", owners[2]);
  channels.clear();
  channels.clear();
  for (const [index, owner] of owners.entries()) {
    owner.dispose();
    owner.onmessage({ obsolete: true });
    expect(callbacks[index]).not.toHaveBeenCalled();
    expect(deliveries[index].dispose).toHaveBeenCalledTimes(1);
  }
});
