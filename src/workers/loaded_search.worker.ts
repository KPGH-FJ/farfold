import { loadedMarkdownFields } from "../runtime/loaded_search_markdown";

// Packaged Markdown/GFM creates inert React elements only. No components are
// mounted and no resource URL is visited. The owner terminates this Worker.
globalThis.fetch = async () => {
  throw new Error("Unavailable");
};
globalThis.onmessage = (event: MessageEvent<unknown>) => {
  const value = event.data;
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    !("text" in value) ||
    Object.keys(value).length !== 2 ||
    !Number.isSafeInteger(value.id) ||
    typeof value.text !== "string" ||
    value.text.length > 1_048_576
  )
    return;
  try {
    globalThis.postMessage({
      id: value.id,
      fields: loadedMarkdownFields(value.text),
    });
  } catch {
    globalThis.postMessage({ id: value.id, failed: true });
  }
};
