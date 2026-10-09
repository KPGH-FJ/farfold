/** Dedicated passive parser. Never load the PDF scripting sandbox. A warning
 * means visual completeness is uncertain; report no document text to the app. */
const incomplete = () => globalThis.postMessage({ farfoldPdfIncomplete: true });
console.warn = incomplete;
console.error = incomplete;
// Install the warning boundary before the official parser initializes.
void import("pdfjs-dist/legacy/build/pdf.worker.mjs");
