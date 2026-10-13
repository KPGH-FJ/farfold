import { Worker as NodeWorker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/** Test-only real thread and port bridge to the unmodified official parser.
 * This is not a browser Worker, installed WebView, or fake PDF.js worker. */
export class PdfNodeParserPort extends EventTarget {
  readonly owner = "test-owner-12345678";
  private thread: NodeWorker;
  private readyPromise: Promise<void>;
  constructor(holdLive = false, cleanupDiagnostic = false) {
    super();
    const require = createRequire(import.meta.url);
    const vendor = pathToFileURL(
      require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
    ).href;
    this.thread = new NodeWorker(
      `
      const {parentPort, workerData} = require('node:worker_threads');
      const port = new EventTarget();
      port.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
      let ready = false, queue = [], count = 0;
      const diagnostic = () => { count++; if (!workerData.holdLive) parentPort.postMessage({kind:'pdfDiagnostic',owner:workerData.owner,count}); };
      console.warn = console.error = diagnostic;
      port.addEventListener('message', event => {
        const value = event.data;
        if (value?.action === 'Terminate' && workerData.cleanupDiagnostic) diagnostic();
        if (value?.kind === 'pdfDiagnosticSnapshot' && value.owner === workerData.owner)
          parentPort.postMessage({kind:'pdfDiagnosticSnapshotResult',owner:workerData.owner,nonce:value.nonce,count});
      });
      const dispatch = data => port.dispatchEvent(new MessageEvent('message', {data}));
      parentPort.on('message', data => { if (ready) dispatch(data); else queue.push(data); });
      (async () => {
        const {WorkerMessageHandler} = await import(workerData.vendor);
        WorkerMessageHandler.initializeFromPort(port);
        ready = true;
        for (const data of queue) dispatch(data);
        queue = [];
        parentPort.postMessage({ownNodeParserReady:true});
      })().catch(() => { parentPort.postMessage({ownNodeParserFailed:true}); });
    `,
      {
        eval: true,
        workerData: { vendor, owner: this.owner, holdLive, cleanupDiagnostic },
      },
    );
    this.readyPromise = new Promise((resolve, reject) => {
      this.thread.on("message", (data) => {
        if (data?.ownNodeParserReady) {
          resolve();
          return;
        }
        if (data?.ownNodeParserFailed) {
          reject(new Error("test parser initialization failed"));
          return;
        }
        this.dispatchEvent(new MessageEvent("message", { data }));
      });
      this.thread.on("error", (error) => {
        reject(error);
        this.dispatchEvent(new Event("error"));
      });
      this.thread.on("messageerror", () =>
        this.dispatchEvent(new Event("messageerror")),
      );
    });
  }
  ready(): Promise<void> {
    return this.readyPromise;
  }
  postMessage(data: unknown, transfer?: Transferable[]): void {
    this.thread.postMessage(data, transfer as never);
  }
  async terminate(): Promise<void> {
    await this.thread.terminate();
  }
}
