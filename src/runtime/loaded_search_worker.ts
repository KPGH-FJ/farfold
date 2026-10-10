/** One query owns one lazy Worker. It never retains a transcript between queries. */
export function createLoadedSearchParser(signal?: AbortSignal) {
  let worker: Worker | undefined;
  let closed = false,
    serial = 0;
  let pending:
    | {
        id: number;
        length: number;
        resolve: (fields: string[]) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortError = () => new DOMException("Search cancelled", "AbortError");
  const fail = (error: Error) => {
    const prior = pending;
    pending = undefined;
    clearTimeout(timer);
    timer = undefined;
    closed = true;
    signal?.removeEventListener("abort", abort);
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      worker = undefined;
    }
    prior?.reject(error);
  };
  const abort = () => fail(abortError());
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return {
    parse(text: string): Promise<string[]> {
      if (closed || signal?.aborted) return Promise.reject(abortError());
      if (pending) return Promise.reject(new Error("Search parser busy"));
      if (text.length > 1_048_576)
        return Promise.reject(new Error("Search parser limit"));
      return new Promise((resolve, reject) => {
        pending = { id: ++serial, length: text.length, resolve, reject };
        try {
          if (!worker) {
            worker = new Worker(
              new URL("../workers/loaded_search.worker.ts", import.meta.url),
              { type: "module" },
            );
            worker.onmessage = (event: MessageEvent<unknown>) => {
              const data = event.data;
              if (
                !pending ||
                !data ||
                typeof data !== "object" ||
                !("id" in data) ||
                data.id !== pending.id
              )
                return;
              if (
                !("fields" in data) ||
                !Array.isArray(data.fields) ||
                Object.keys(data).length !== 2 ||
                data.fields.length > 200_000
              ) {
                fail(new Error("Search parser failed"));
                return;
              }
              let size = 0;
              for (const field of data.fields) {
                if (
                  typeof field !== "string" ||
                  (size += field.length) > pending.length * 2 + 1024
                ) {
                  fail(new Error("Search parser failed"));
                  return;
                }
              }
              const prior = pending;
              pending = undefined;
              clearTimeout(timer);
              timer = undefined;
              prior.resolve(data.fields);
            };
            worker.onerror = () => fail(new Error("Search parser failed"));
            worker.onmessageerror = () =>
              fail(new Error("Search parser failed"));
          }
          timer = setTimeout(
            () => fail(new Error("Search parser timed out")),
            10_000,
          );
          worker.postMessage({ id: serial, text });
        } catch {
          fail(new Error("Search parser unavailable"));
        }
      });
    },
    dispose: abort,
  };
}
