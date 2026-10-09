import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  readdirSync,
} from "node:fs";
import { resolve, dirname, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const outputDirectory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(outputDirectory, "../../../..");

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");
}

export function writeEvidenceIndex() {
  const pages = readdirSync(outputDirectory)
    .filter((name) => name.endsWith(".html") && name !== "index.html")
    .sort()
    .map((name) => {
      const source = readFileSync(resolve(outputDirectory, name), "utf8");
      const title =
        /<title>(.*?)<\/title>/s
          .exec(source)?.[1]
          ?.replace(/ · 正式组件受控呈现$/, "") ?? name;
      return `<li><a href="./${escapeHtml(name)}">${escapeHtml(title)}</a><code>${escapeHtml(name)}</code></li>`;
    })
    .join("\n");
  writeFileSync(
    resolve(outputDirectory, "index.html"),
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>正式组件受控呈现目录</title><style>body{max-width:960px;margin:48px auto;padding:0 24px;background:#f7f7f5;color:#24272c;font:15px/1.6 system-ui}h1{font-size:28px}p{color:#616975}ul{padding:0;list-style:none}li{background:white;border:1px solid #e2e3e6;border-radius:12px;padding:16px 20px;margin:12px 0}a{color:inherit;font-size:17px;font-weight:600}code{display:block;color:#737985;font-size:12px;margin-top:4px}</style></head><body><h1>正式组件受控呈现</h1><p>使用当前正式 React 组件与生产 CSS，内容和状态由测试文件控制。这里只检查视觉呈现；不是安装版实测，也不证明 Agent、账号、通知投递或其他外部能力已通过。页面为静态预览，按钮不执行操作。</p><ul>${pages}</ul></body></html>`,
  );
}

/** Follow the production import graph in import order; no prototype styles. */
export function productionCss() {
  const visited = new Set(),
    styles = [];
  const visit = (path) => {
    if (visited.has(path) || !existsSync(path)) return;
    visited.add(path);
    const text = readFileSync(path, "utf8");
    if (extname(path) === ".css") {
      styles.push(`/* ${relative(repository, path)} */\n${text}`);
      return;
    }
    const imports = text.matchAll(
      /import\s+(?:[^;]*?\sfrom\s+)?["']([^"']+)["']/g,
    );
    for (const match of imports) {
      if (!match[1].startsWith(".")) continue;
      const target = resolve(dirname(path), match[1]);
      const candidate = [
        target,
        `${target}.tsx`,
        `${target}.ts`,
        `${target}.js`,
        resolve(target, "index.ts"),
      ].find(existsSync);
      if (candidate) visit(candidate);
    }
  };
  visit(resolve(repository, "src/main.tsx"));
  return styles.join("\n");
}

export function writeEvidencePage(name, title, markup) {
  const css = productionCss();
  writeFileSync(resolve(outputDirectory, "production.css"), css);
  const assets = new Set(
    [...markup.matchAll(/src="\/(?!\/)([^"]+)"/g)].map((m) => m[1]),
  );
  for (const asset of assets) {
    const source = resolve(repository, "public", asset);
    if (
      !source.startsWith(resolve(repository, "public") + "/") ||
      !existsSync(source)
    )
      continue;
    const target = resolve(outputDirectory, "assets", asset);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    markup = markup.replaceAll(`src="/${asset}"`, `src="./assets/${asset}"`);
  }
  // The real dialog is opened by a DOM effect. SSR provides the same open state.
  markup = markup.replaceAll("<dialog ", "<dialog open ");
  const html = `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · 正式组件受控呈现</title><link rel="stylesheet" href="./production.css"><style>.evidence-banner{height:36px;display:flex;align-items:center;gap:16px;padding:0 16px;background:#20252b;color:white;font:12px system-ui;position:relative;z-index:10000;box-sizing:border-box}.evidence-banner a{color:white;text-decoration:underline}#root.evidence-root{height:calc(100vh - 36px)}.evidence-root:has(>dialog){background:var(--sidebar)}.evidence-root>dialog{top:36px}</style></head><body><aside class="evidence-banner"><span>受控数据 · 正式组件与当前生产 CSS · 非安装实测 · 静态预览</span><a href="./index.html">画册目录</a></aside><div id="root" class="evidence-root">${markup}</div></body></html>`;
  writeFileSync(resolve(outputDirectory, name), html);
  writeEvidenceIndex();
  return html;
}
