// Deterministic store workload. Timing is not installed-app frame/input latency.
import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => []),
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads } from "./sessions";

it("preserves two interleaved streams under a fixed notification workload", () => {
  const states = ["perf-a", "perf-b"].map((id) => {
    const s = threads.markOpenFailed(
      `fixture:/perf:${id}`,
      "fixture",
      "/perf",
      id,
      "fixture",
    );
    s.openError = null;
    return s;
  });
  let notifications = 0;
  const stop = threads.subscribe(() => notifications++);
  const apply = threads as unknown as {
    applyChannelEvent(key: string, e: unknown): void;
  };
  const samples: number[] = [];
  const chunk = "0123456789abcdef".repeat(4);
  const start = performance.now();
  for (let i = 0; i < 2000; i++) {
    const at = performance.now();
    apply.applyChannelEvent(states[i % 2].key, {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: chunk },
      },
    });
    samples.push(performance.now() - at);
  }
  stop();
  samples.sort((a, b) => a - b);
  console.info(
    "STORE_WORKLOAD",
    JSON.stringify({
      tier: "synthetic_fixture",
      chunks: 2000,
      bytesPerChunk: 64,
      notifications,
      elapsedMs: performance.now() - start,
      eventP95Ms: samples[1899],
    }),
  );
  for (const s of states) {
    const item = s.items[0];
    expect(item.kind === "agent" && item.text).toBe(chunk.repeat(1000));
  }
});
