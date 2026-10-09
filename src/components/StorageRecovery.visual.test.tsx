import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StorageRecovery } from "./StorageRecovery";
import { STRINGS } from "../runtime/strings";
const h = vi.hoisted(() => ({
  io: vi.fn(() => {
    throw new Error("Visual fixture has no external IO");
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.io }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: h.io }));
const directory = "/tmp/farfold-storage-recovery-20261009";
const css = [
  "src/styles.css",
  "src/product-shell.css",
  "src/components/StorageRecovery.css",
]
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
it.each(["light", "dark"])(
  "renders the actual recovery component in %s without data access",
  (theme) => {
    const html = renderToStaticMarkup(
      <StorageRecovery
        message={STRINGS.storageRecovery.issues.corrupt}
        onRetry={async () => {}}
      />,
    );
    expect(html).toContain('aria-labelledby="storage-recovery-title"');
    expect(html).toContain(STRINGS.storageRecovery.export);
    expect(html).not.toContain("重建");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `${theme}.html`),
      `<!doctype html><html lang="zh-CN" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Farfold 资料恢复受控界面</title><style>${css}</style></head><body>${html}</body></html>`,
    );
    expect(h.io).not.toHaveBeenCalled();
  },
);
