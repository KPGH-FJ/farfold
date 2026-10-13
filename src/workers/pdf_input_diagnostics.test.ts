import { expect, it, vi } from "vitest";
import { installPdfInputDiagnostics } from "./pdf_input_diagnostics";
import { createPdfInputDiagnosticGate } from "../runtime/pdf_input_core";

class Port extends EventTarget {
  postMessage = vi.fn();
  receive(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}
const owner = "owner-12345678";
it("counts observed parser warnings without serializing raw diagnostics or document text", () => {
  const port = new Port(),
    local = { warn: vi.fn(), error: vi.fn() };
  installPdfInputDiagnostics(
    {
      console: local,
      addEventListener: (t, cb) =>
        port.addEventListener(t, cb as EventListener),
      postMessage: (value) => port.postMessage(value),
    },
    owner,
  );
  local.warn("private text", { credentials: "secret" });
  local.error(new Error("document text"));
  port.receive({
    kind: "pdfDiagnosticSnapshot",
    owner,
    nonce: "nonce-12345678",
  });
  expect(port.postMessage.mock.calls).toEqual([
    [{ kind: "pdfDiagnostic", owner, count: 1 }],
    [{ kind: "pdfDiagnostic", owner, count: 2 }],
    [
      {
        kind: "pdfDiagnosticSnapshotResult",
        owner,
        nonce: "nonce-12345678",
        count: 2,
      },
    ],
  ]);
});
it("makes malformed or foreign diagnostic controls fatal instead of certifying a zero snapshot", () => {
  const port = new Port(),
    local = { warn: vi.fn(), error: vi.fn() };
  installPdfInputDiagnostics(
    {
      console: local,
      addEventListener: (t, cb) =>
        port.addEventListener(t, cb as EventListener),
      postMessage: (value) => port.postMessage(value),
    },
    owner,
  );
  for (const request of [
    {
      kind: "pdfDiagnosticSnapshot",
      owner: "another",
      nonce: "nonce-12345678",
    },
    { kind: "pdfDiagnosticSnapshot", owner, nonce: "short" },
    {
      kind: "pdfDiagnosticSnapshot",
      owner,
      nonce: "nonce-12345678",
      raw: true,
    },
  ])
    port.receive(request);
  expect(port.postMessage.mock.calls.map((c) => c[0].count)).toEqual([1, 2, 3]);
  expect(
    port.postMessage.mock.calls.every((c) => c[0].kind === "pdfDiagnostic"),
  ).toBe(true);
});
it("requires the same exact port, owner and fresh nonce for the post-cleanup snapshot", async () => {
  const port = new Port(),
    gate = createPdfInputDiagnosticGate(port as unknown as Worker, owner);
  const pending = gate.snapshot();
  const sent = port.postMessage.mock.calls[0][0];
  expect(sent).toMatchObject({ kind: "pdfDiagnosticSnapshot", owner });
  expect(sent.nonce.length).toBeGreaterThan(8);
  port.receive({
    kind: "pdfDiagnosticSnapshotResult",
    owner,
    nonce: sent.nonce,
    count: 0,
  });
  expect(await pending).toBe(0);
  expect(gate.failed()).toBe(false);
  gate.dispose();
});
it.each([
  "wrongOwner",
  "wrongNonce",
  "extra",
  "negative",
  "wrongKind",
  "parserError",
  "messageerror",
])("refuses unreliable barrier %s", async (mode) => {
  const port = new Port(),
    gate = createPdfInputDiagnosticGate(port as unknown as Worker, owner);
  const pending = expect(gate.snapshot()).rejects.toMatchObject({
    code: "incomplete",
  });
  const nonce = port.postMessage.mock.calls[0][0].nonce;
  if (mode === "parserError" || mode === "messageerror")
    port.dispatchEvent(new Event(mode === "parserError" ? "error" : mode));
  else
    port.receive({
      kind:
        mode === "wrongKind"
          ? "pdfDiagnosticUnknown"
          : "pdfDiagnosticSnapshotResult",
      owner: mode === "wrongOwner" ? "other" : owner,
      nonce: mode === "wrongNonce" ? "other" : nonce,
      count: mode === "negative" ? -1 : 0,
      ...(mode === "extra" ? { raw: "private" } : {}),
    });
  await pending;
  expect(gate.failed()).toBe(true);
  gate.dispose();
});
it("rejects a real-time diagnostic, duplicate/decreasing reply or disposed barrier", async () => {
  const port = new Port(),
    gate = createPdfInputDiagnosticGate(port as unknown as Worker, owner);
  const pending = expect(gate.snapshot()).rejects.toMatchObject({
    code: "incomplete",
  });
  port.receive({ kind: "pdfDiagnostic", owner, count: 1 });
  await pending;
  expect(gate.failed()).toBe(true);
  await expect(gate.snapshot()).rejects.toMatchObject({ code: "incomplete" });
  gate.dispose();
  const other = createPdfInputDiagnosticGate(port as unknown as Worker, owner);
  const disposed = expect(other.snapshot()).rejects.toMatchObject({
    code: "incomplete",
  });
  other.dispose();
  await disposed;
});
