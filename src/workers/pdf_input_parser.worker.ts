// Static dependency evaluation installs diagnostics before vendor evaluation;
// queued requests cannot race a detached import. Vendor bytes are unchanged.
import "./pdf_input_diagnostics";
import "pdfjs-dist/legacy/build/pdf.worker.mjs";
if (!new URL(globalThis.location.href).searchParams.get("pdfInputOwner"))
  throw new Error("unsupported");
