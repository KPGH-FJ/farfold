import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const server = await createServer({
  root,
  configFile: fileURLToPath(
    new URL("../../../vite.config.ts", import.meta.url),
  ),
  server: { host: "127.0.0.1", port: 1420, strictPort: true, open: false },
});
try {
  await server.listen();
  const results = [];
  for (const path of ["/", "/src/main.tsx"]) {
    const response = await fetch(`http://127.0.0.1:1420${path}`, {
      signal: AbortSignal.timeout(10000),
    });
    const body = await response.text();
    if (response.status !== 200 || !body.length) {
      throw new Error(
        `Development response failed: ${path} ${response.status}`,
      );
    }
    results.push({
      path,
      status: response.status,
      bytes: Buffer.byteLength(body),
    });
  }
  console.log(JSON.stringify({ results, desktopAppStarted: false }));
} finally {
  await server.close();
}
