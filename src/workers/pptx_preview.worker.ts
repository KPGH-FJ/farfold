import { parsePptx } from "../runtime/pptx_parse";
import { checkedPptxDocument } from "../runtime/pptx_validation";
import { decodePptxImages } from "../runtime/pptx_decode";
import { PptxError, type PptxWorkerInput } from "../runtime/pptx_types";

// Packaged code only. Document XML, text and resources remain inert, and no
// document-provided URL, HTML, script, font download or app IPC is evaluated.
globalThis.fetch = async () => {
  throw new PptxError("unsupported");
};
let started = false;
globalThis.onmessage = async (event: MessageEvent<PptxWorkerInput>) => {
  if (started) return;
  started = true;
  try {
    const document = checkedPptxDocument(
      parsePptx(event.data),
      new Set(event.data.parts.map((part) => part.name)),
    );
    await decodePptxImages(document);
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
      code: error instanceof PptxError ? error.code : "invalid",
    });
  }
};
