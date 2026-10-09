/** Evaluated before the statically imported parser. Diagnostics invalidate the
 * preview without forwarding library text or document contents. */
const incomplete = () => globalThis.postMessage({ farfoldPdfIncomplete: true });
console.warn = incomplete;
console.error = incomplete;
export {};
