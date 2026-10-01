#!/usr/bin/env node
// An isolated official-SDK request probe. Every TCP request goes to this
// process's 127.0.0.1 listener; no Agent, cloud service or user config is opened.
import { createServer, request as httpRequest } from "node:http";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const evidenceDir = dirname(fileURLToPath(import.meta.url));
const EXPECTED_VERSION = "3.0.111";
const CANARY = {
  selected: "FARFOLD_LOCAL_CANARY_SELECTED_KEY",
  header: "FARFOLD_LOCAL_CANARY_HEADER_KEY",
  token: "FARFOLD_LOCAL_CANARY_BEARER_TOKEN",
  inherited: "FARFOLD_LOCAL_CANARY_INHERITED_KEY",
};
const MODEL = "farfold-local-canary-model";
const BODY_LIMIT = 16 * 1024;
const RESPONSE_LIMIT = 64 * 1024;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const outputArg = argument("--out");
const output = outputArg ? resolve(outputArg) : undefined;
if (output) {
  const inside = relative(evidenceDir, output);
  if (
    !inside ||
    inside === ".." ||
    inside.startsWith(`..${sep}`) ||
    isAbsolute(inside)
  )
    throw new Error("CANARY_OUTPUT_OUTSIDE_EVIDENCE");
}

async function finish(report, exitCode) {
  const safe = { ...report, exitCode };
  if (output) await writeFile(output, `${JSON.stringify(safe, null, 2)}\n`);
  // The report contains only fixed labels, booleans, counts and public versions.
  process.stdout.write(`${JSON.stringify(safe)}\n`);
  process.exitCode = exitCode;
}

async function sdk() {
  const supplied = argument("--sdk-root");
  if (!supplied || !isAbsolute(supplied)) return { unavailable: true };
  try {
    const root = await realpath(supplied);
    const manifest = JSON.parse(await readFile(resolve(root, "package.json")));
    if (
      manifest.name !== "@ai-sdk/anthropic" ||
      manifest.version !== EXPECTED_VERSION
    )
      return { unavailable: true, incompatiblePublicManifest: true };
    // These replacements affect this disposable test process only. No original
    // environment value is read, preserved, printed or written to a config.
    process.env.ANTHROPIC_API_KEY = CANARY.inherited;
    process.env.ANTHROPIC_AUTH_TOKEN = CANARY.token;
    const require = createRequire(resolve(root, "package.json"));
    const module = require(root);
    if (typeof module.createAnthropic !== "function")
      return { unavailable: true, missingPublicFactory: true };
    return { createAnthropic: module.createAnthropic };
  } catch {
    // Module errors can include paths or values. Never include their text.
    return { unavailable: true, loadFailed: true };
  }
}

const loaded = await sdk();
if (loaded.unavailable) {
  await finish(
    {
      schema: 1,
      sdkVersion: EXPECTED_VERSION,
      executed: false,
      passed: false,
      status: "sdk_unavailable",
      incompatiblePublicManifest: !!loaded.incompatiblePublicManifest,
      missingPublicFactory: !!loaded.missingPublicFactory,
      loadFailed: !!loaded.loadFailed,
      networkRequests: 0,
      boundary: "No official SDK request was executed.",
    },
    2,
  );
} else {
  const sockets = new Set();
  const observations = [];
  let current;
  const server = createServer((incoming, response) => {
    let bytes = 0;
    const chunks = [];
    incoming.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > BODY_LIMIT) incoming.destroy();
      else chunks.push(chunk);
    });
    incoming.on("end", () => {
      if (!current || bytes > BODY_LIMIT) {
        response.writeHead(400).end();
        return;
      }
      const body = Buffer.concat(chunks).toString("utf8");
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        response.writeHead(400).end();
        return;
      }
      const key = incoming.headers["x-api-key"];
      const auth = incoming.headers.authorization;
      observations.push({
        case: current.id,
        pathMatchesSdkRequest: incoming.url === current.requestPath,
        intendedBasePathMatches: incoming.url === current.intendedPath,
        modelMatchesSelection: payload.model === MODEL,
        selectedKeyExact: key === CANARY.selected,
        headerKeyExact: key === CANARY.header,
        selectedKeyPresent:
          typeof key === "string" && key.includes(CANARY.selected),
        inheritedKeyPresent:
          typeof key === "string" && key.includes(CANARY.inherited),
        bearerPresent: typeof auth === "string" && auth.includes(CANARY.token),
        versionMatches: incoming.headers["anthropic-version"] === "2023-06-01",
        bodyContainsCanary: Object.values(CANARY).some((value) =>
          body.includes(value),
        ),
        requestBytes: bytes,
      });
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: "msg_local_canary",
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [{ type: "text", text: "OK" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((ok, no) => {
    server.once("error", no);
    server.listen(0, "127.0.0.1", ok);
  });
  const address = server.address();
  if (
    !address ||
    typeof address === "string" ||
    address.address !== "127.0.0.1"
  )
    throw new Error("CANARY_LISTENER_NOT_LOOPBACK");
  const origin = `http://127.0.0.1:${address.port}`;

  // The official hostname cases inspect SDK URL construction but route only to
  // the local listener. They never create a public DNS/TCP request.
  const cases = [
    { id: "local_root", base: origin, path: "/messages" },
    { id: "local_v1", base: `${origin}/v1`, path: "/v1/messages" },
    { id: "custom_prefix", base: `${origin}/custom`, path: "/custom/messages" },
    {
      id: "custom_prefix_v1",
      base: `${origin}/custom/v1`,
      path: "/custom/v1/messages",
    },
    { id: "trailing_slash", base: `${origin}/v1/`, path: "/v1/messages" },
    {
      id: "official_root_intercepted",
      base: "https://api.anthropic.com",
      path: "/v1/messages",
      official: true,
    },
    {
      id: "official_v1_intercepted",
      base: "https://api.anthropic.com/v1",
      path: "/v1/messages",
      official: true,
    },
    {
      id: "explicit_model_override",
      base: `${origin}/v1`,
      path: "/v1/messages",
      model: "farfold-local-overridden-model",
      unsafe: true,
    },
    {
      id: "explicit_base_override",
      base: `${origin}/other`,
      path: "/other/messages",
      intended: "/v1/messages",
      unsafe: true,
    },
    {
      id: "lowercase_key_header_override",
      base: `${origin}/v1`,
      path: "/v1/messages",
      headers: { "x-api-key": CANARY.header },
      unsafe: true,
    },
    {
      id: "mixed_case_key_header_override",
      base: `${origin}/v1`,
      path: "/v1/messages",
      headers: { "X-Api-Key": CANARY.header },
      unsafe: true,
    },
    {
      id: "bearer_header_addition",
      base: `${origin}/v1`,
      path: "/v1/messages",
      headers: { Authorization: `Bearer ${CANARY.token}` },
      unsafe: true,
    },
    {
      id: "both_auth_arguments",
      base: `${origin}/v1`,
      path: "/v1/messages",
      token: CANARY.token,
      blocked: true,
    },
    {
      id: "explicit_empty_auth_token",
      base: `${origin}/v1`,
      path: "/v1/messages",
      token: "",
    },
  ];

  const results = [];
  let rejectedTargets = 0;
  try {
    for (const sample of cases) {
      current = {
        id: sample.id,
        requestPath: sample.path,
        intendedPath: sample.intended ?? sample.path,
      };
      const before = observations.length;
      const guardedFetch = async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const validOrigin = sample.official
          ? url.origin === "https://api.anthropic.com"
          : url.origin === origin;
        if (
          !validOrigin ||
          url.pathname !== sample.path ||
          url.search ||
          url.hash ||
          url.username ||
          url.password ||
          request.method !== "POST"
        ) {
          rejectedTargets++;
          throw new Error("CANARY_REQUEST_TARGET_REJECTED");
        }
        const body = await request.text();
        if (Buffer.byteLength(body) > BODY_LIMIT)
          throw new Error("CANARY_REQUEST_TOO_LARGE");
        return new Promise((ok, no) => {
          const outgoing = httpRequest(
            {
              hostname: "127.0.0.1",
              port: address.port,
              method: request.method,
              path: sample.path,
              headers: Object.fromEntries(request.headers),
              signal: request.signal,
            },
            (reply) => {
              const chunks = [];
              let bytes = 0;
              reply.on("data", (chunk) => {
                bytes += chunk.length;
                if (bytes > RESPONSE_LIMIT) reply.destroy();
                else chunks.push(chunk);
              });
              reply.once("error", no);
              reply.on("end", () =>
                ok(
                  new Response(Buffer.concat(chunks), {
                    status: reply.statusCode,
                    headers: reply.headers,
                  }),
                ),
              );
            },
          );
          outgoing.once("error", no);
          outgoing.end(body);
        });
      };
      let error = false;
      try {
        const provider = loaded.createAnthropic({
          apiKey: CANARY.selected,
          baseURL: sample.base,
          ...(sample.token !== undefined ? { authToken: sample.token } : {}),
          ...(sample.headers ? { headers: sample.headers } : {}),
          fetch: guardedFetch,
        });
        await provider(sample.model ?? MODEL).doGenerate({
          prompt: [
            {
              role: "user",
              content: [{ type: "text", text: "Reply exactly OK." }],
            },
          ],
          maxOutputTokens: 16,
          abortSignal: AbortSignal.timeout(3000),
        });
      } catch {
        error = true;
      }
      const own = observations.slice(before);
      const expectedRequest = !sample.blocked && !error && own.length === 1;
      const safeSelection =
        own.length === 1 &&
        own.every(
          (record) =>
            record.pathMatchesSdkRequest &&
            record.intendedBasePathMatches &&
            record.modelMatchesSelection &&
            record.selectedKeyExact &&
            !record.inheritedKeyPresent &&
            !record.bearerPresent &&
            record.versionMatches &&
            !record.bodyContainsCanary,
        );
      results.push({
        case: sample.id,
        interceptedOfficialHost: !!sample.official,
        sdkError: error,
        networkRequests: own.length,
        selectionPreserved: safeSelection,
        expectedObservation: sample.blocked
          ? error && own.length === 0
          : expectedRequest && (sample.unsafe ? !safeSelection : safeSelection),
      });
    }
  } finally {
    const closed = [...sockets].map((socket) => {
      if (socket.closed) return Promise.resolve();
      return new Promise((ok) => {
        socket.once("close", ok);
        socket.destroy();
      });
    });
    await Promise.all(closed);
    await new Promise((ok) => server.close(ok));
  }
  const passed =
    results.every((result) => result.expectedObservation) &&
    rejectedTargets === 0 &&
    !server.listening &&
    sockets.size === 0;
  await finish(
    {
      schema: 1,
      sdkVersion: EXPECTED_VERSION,
      nodeVersion: process.versions.node,
      executed: true,
      passed,
      status: "sdk_probe_finished",
      allTcpTargetsLoopback: true,
      rejectedTargets,
      networkRequests: observations.length,
      listenerClosed: !server.listening,
      openSockets: sockets.size,
      results,
      observations,
      pendingChecks: [
        "opencode_config_model_api_id_mapping",
        "opencode_model_provider_npm_precedence",
        "opencode_managed_policy_after_inline",
        "opencode_plugin_config_and_request_hooks",
        "installed_agent_service_delivery_and_cold_restore",
      ],
      boundary:
        "Official SDK only; not OpenCode configuration or installed Agent validation.",
    },
    passed ? 0 : 1,
  );
}
