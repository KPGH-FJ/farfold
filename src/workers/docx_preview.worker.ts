import { parseDocx } from "../runtime/docx_parse";
import { decodeDocxImages } from "../runtime/docx_decode";
import { DocxError, type DocxWorkerInput } from "../runtime/docx_types";
// Only packaged parser code executes. Inputs and resources stay inert; no DOM,
// app IPC, HTML, field evaluation, or remote resource loading is provided.
globalThis.fetch = async () => {
  throw new DocxError("unsupported");
};
let started = false;
globalThis.onmessage = async (event: MessageEvent<DocxWorkerInput>) => {
  if (started) return;
  started = true;
  try {
    const document = parseDocx(event.data);
    await decodeDocxImages(document);
    globalThis.postMessage(
      { kind: "ready", document },
      {
        transfer: document.images.map(
          (image) => image.bytes.buffer as ArrayBuffer,
        ),
      },
    );
  } catch (error) {
    globalThis.postMessage({
      kind: "error",
      code: error instanceof DocxError ? error.code : "invalid",
    });
  }
};
