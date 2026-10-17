import { expect, it } from "vitest";
import {
  MessageMediaBudget,
  MAX_ACTIVE_MESSAGE_MEDIA,
  MAX_ACTIVE_MESSAGE_MEDIA_BYTES,
} from "./message_media_budget";

it("shares the four-preview limit and only an explicit acquire retries", () => {
  const pool = new MessageMediaBudget();
  const owners = Array.from({ length: MAX_ACTIVE_MESSAGE_MEDIA }, () =>
    pool.acquire(1),
  );
  expect(owners.every(Boolean)).toBe(true);
  expect(pool.acquire(1)).toBeNull();
  owners[0]!.release();
  const replacement = pool.acquire(1);
  expect(replacement).not.toBeNull();
  // Stale cleanup is idempotent and cannot release the replacement's slot.
  owners[0]!.release();
  expect(pool.acquire(1)).toBeNull();
  replacement!.release();
  expect(pool.acquire(1)).not.toBeNull();
});

it("admits exactly 32MiB across owners and rejects even one additional byte", () => {
  const pool = new MessageMediaBudget();
  const first = pool.acquire(MAX_ACTIVE_MESSAGE_MEDIA_BYTES / 2)!;
  const second = pool.acquire(MAX_ACTIVE_MESSAGE_MEDIA_BYTES / 2)!;
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(pool.acquire(1)).toBeNull();
  first.release();
  const next = pool.acquire(MAX_ACTIVE_MESSAGE_MEDIA_BYTES / 2)!;
  expect(next).not.toBeNull();
  first.release();
  expect(pool.acquire(1)).toBeNull();
  second.release();
  next.release();
  expect(pool.acquire(MAX_ACTIVE_MESSAGE_MEDIA_BYTES)).not.toBeNull();
});

it.each([0, -1, 0.5, NaN, Infinity, MAX_ACTIVE_MESSAGE_MEDIA_BYTES + 1])(
  "refuses invalid or oversized byte reservations %s without consuming a slot",
  (bytes) => {
    const pool = new MessageMediaBudget();
    expect(pool.acquire(bytes)).toBeNull();
    expect(pool.acquire(MAX_ACTIVE_MESSAGE_MEDIA_BYTES)).not.toBeNull();
  },
);

it("arbitrary owner release order leaves both budgets reusable", () => {
  const pool = new MessageMediaBudget();
  for (let round = 0; round < 50; round++) {
    const leases = Array.from({ length: 4 }, () =>
      pool.acquire(8 * 1024 * 1024)!,
    );
    expect(leases.every(Boolean)).toBe(true);
    for (const i of [2, 0, 3, 1, 0, 3]) leases[i].release();
  }
  expect(pool.acquire(MAX_ACTIVE_MESSAGE_MEDIA_BYTES)).not.toBeNull();
});
