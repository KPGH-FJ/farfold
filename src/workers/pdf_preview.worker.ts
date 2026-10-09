/** Dedicated passive parser. Never load the PDF scripting sandbox. A warning
 * means visual completeness is uncertain; report no document text to the app. */
// Static dependencies finish evaluating before queued Worker messages run.
// A detached dynamic import lets the caller's first requests reach this worker
// before PDF.js installs its listener; PDFWorker.create({ port }) does not wait.
import "./pdf_parser_diagnostics";
import "pdfjs-dist/legacy/build/pdf.worker.mjs";
