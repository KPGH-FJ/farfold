import { describe, expect, it, vi } from "vitest";
import {
  ApiRequestScope,
  preservesLegacyService,
  type ApiResult,
  type Credential,
  type CredentialInput,
} from "./credentials";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
function deferred() {
  let resolve!: (value: ApiResult) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<ApiResult>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const result = (requestId: string, message: string): ApiResult => ({
  requestId,
  status: "success",
  message,
  models: [],
});

it("allows an incomplete legacy record to rotate its key without inventing service metadata", () => {
  const saved: Credential = {
    id: "legacy",
    label: "old key",
    provider: "",
    endpoint: "https://example.test/v1/chat/completions",
    apiType: "",
    models: [],
    revision: "before",
    complete: false,
    deleting: false,
    grants: [{ agentId: "a", envName: "OLD_KEY", overrideExisting: true }],
  };
  const draft: CredentialInput = {
    ...saved,
    label: "new description",
    key: "replacement",
  };
  expect(preservesLegacyService(saved, draft)).toBe(true);
  expect(preservesLegacyService(saved, { ...draft, key: "" })).toBe(true);
  expect(
    preservesLegacyService(saved, {
      ...draft,
      endpoint: "https://other.test/v1",
    }),
  ).toBe(false);
  expect(
    preservesLegacyService(saved, { ...draft, apiType: "chat-completions" }),
  ).toBe(false);
  expect(preservesLegacyService(saved, { ...draft, models: ["model-x"] })).toBe(
    false,
  );
  expect(preservesLegacyService({ ...saved, complete: true }, draft)).toBe(
    false,
  );
  expect(preservesLegacyService(null, draft)).toBe(false);
});

describe("API diagnostic ownership", () => {
  it("ignores an old service response after the editor changes, without cancelling the new test", async () => {
    const cancelled = vi.fn(async () => true);
    const scope = new ApiRequestScope(cancelled);
    const first = deferred();
    const second = deferred();
    const receive = vi.fn();
    const fail = vi.fn();
    let firstId = "",
      secondId = "";
    const oldRequest = scope.run(
      (id) => {
        firstId = id;
        return first.promise;
      },
      receive,
      fail,
    );
    scope.invalidate();
    const newRequest = scope.run(
      (id) => {
        secondId = id;
        return second.promise;
      },
      receive,
      fail,
    );
    first.resolve(result(firstId, "old service"));
    await oldRequest;
    expect(receive).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledExactlyOnceWith(firstId);
    second.resolve(result(secondId, "selected service"));
    await newRequest;
    expect(receive).toHaveBeenCalledExactlyOnceWith(
      result(secondId, "selected service"),
    );
    expect(fail).not.toHaveBeenCalled();
  });

  it("does not start a duplicate test or retry a failure", async () => {
    const scope = new ApiRequestScope(vi.fn(async () => true));
    const request = deferred();
    const duplicate = vi.fn();
    const failed = vi.fn();
    const running = scope.run(() => request.promise, vi.fn(), failed);
    await scope.run(duplicate, vi.fn(), failed);
    request.reject(new Error("connection failed"));
    await running;
    expect(duplicate).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("sends cancellation to the current request and keeps its confirmed cancelled result", async () => {
    const cancel = vi.fn(async () => true);
    const scope = new ApiRequestScope(cancel);
    const request = deferred();
    const receive = vi.fn();
    let id = "";
    const running = scope.run(
      (value) => {
        id = value;
        return request.promise;
      },
      receive,
      vi.fn(),
    );
    await scope.cancel();
    expect(cancel).toHaveBeenCalledExactlyOnceWith(id);
    request.resolve({ ...result(id, "cancelled"), status: "cancelled" });
    await running;
    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled" }),
    );
  });

  it("keeps an unconfirmed cancellation pending without admitting duplicate work", async () => {
    const scope = new ApiRequestScope(vi.fn(async () => false));
    const request = deferred();
    const duplicate = vi.fn();
    let id = "";
    const running = scope.run(
      (value) => {
        id = value;
        return request.promise;
      },
      vi.fn(),
      vi.fn(),
    );
    expect(await scope.cancel()).toBe(false);
    await scope.run(duplicate, vi.fn(), vi.fn());
    expect(duplicate).not.toHaveBeenCalled();
    request.resolve(result(id, "completed before cancellation"));
    await running;
    expect(await scope.cancel()).toBe(true);
  });

  it("ignores a cancellation error arriving after its test finished", async () => {
    let rejectCancel!: (reason: unknown) => void;
    const scope = new ApiRequestScope(
      () =>
        new Promise<boolean>((_, reject) => {
          rejectCancel = reject;
        }),
    );
    const request = deferred();
    let id = "";
    const running = scope.run(
      (value) => {
        id = value;
        return request.promise;
      },
      vi.fn(),
      vi.fn(),
    );
    const cancelling = scope.cancel();
    request.resolve(result(id, "completed"));
    await running;
    rejectCancel(new Error("late cancellation failure"));
    expect(await cancelling).toBe(true);
  });

  it("does not render another request's result, and suppresses errors after unmount", async () => {
    const scope = new ApiRequestScope(vi.fn(async () => true));
    const receive = vi.fn();
    const fail = vi.fn();
    await scope.run(
      async () => result("wrong-id", "other result"),
      receive,
      fail,
    );
    expect(receive).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledTimes(1);
    const request = deferred();
    const pending = scope.run(() => request.promise, receive, fail);
    scope.invalidate();
    request.reject(new Error("late error"));
    await pending;
    expect(fail).toHaveBeenCalledTimes(1);
  });
});
