/** Installed before the official parser import. Never serialize diagnostics or
 * document text; this is a count of observed emissions, not semantic authority. */
export interface PdfInputDiagnosticTarget {
  console: Pick<Console, "warn" | "error">;
  addEventListener(
    type: "message",
    callback: (event: MessageEvent) => void,
  ): void;
  postMessage(value: unknown): void;
}
export function installPdfInputDiagnostics(
  target: PdfInputDiagnosticTarget,
  owner: string,
): void {
  if (!/^[a-zA-Z0-9-]{8,128}$/.test(owner)) throw new Error("unsupported");
  let count = 0;
  const diagnostic = () => {
    count++;
    target.postMessage({ kind: "pdfDiagnostic", owner, count });
  };
  target.console.warn = diagnostic;
  target.console.error = diagnostic;
  target.addEventListener("message", (event) => {
    const item = event.data;
    if (!item || item.kind !== "pdfDiagnosticSnapshot") return;
    if (
      Object.keys(item).length !== 3 ||
      item.owner !== owner ||
      typeof item.nonce !== "string" ||
      !/^[a-zA-Z0-9-]{8,128}$/.test(item.nonce)
    ) {
      diagnostic();
      return;
    }
    target.postMessage({
      kind: "pdfDiagnosticSnapshotResult",
      owner,
      nonce: item.nonce,
      count,
    });
  });
}
// A parser URL alone supplies this own ephemeral owner; no product environment
// flags or document-controlled names are consulted.
if (typeof globalThis.location !== "undefined") {
  const owner = new URL(globalThis.location.href).searchParams.get(
    "pdfInputOwner",
  );
  if (owner) installPdfInputDiagnostics(globalThis, owner);
}
