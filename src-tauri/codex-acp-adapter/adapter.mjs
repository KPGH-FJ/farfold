// Farfold maintained ACP 1 boundary, version 0.1.5. Codex owns all Agent work.
// Deliberately read-only first slice: no login, session creation, or model calls.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, lstatSync } from "node:fs";
import { join } from "node:path";

const VERSION = "0.1.5";
const SHA = "9070e47d422129106bc41ca651a9998b06a6c55bd42a7c3362b48f1d2850766f";
const MAX = 1024 * 1024;
const launch = JSON.parse(process.env.FARFOLD_CODEX_ACP_LAUNCH ?? "null");
const scope = launch?.scope;
const keys = [
  "runtimeProductId",
  "installationId",
  "runtimeBuildId",
  "adapterId",
  "adapterBuildId",
  "connectionId",
  "profileId",
  "generation",
];
if (
  !scope ||
  Object.keys(scope).length !== keys.length ||
  keys.some((key) =>
    key === "generation"
      ? !Number.isSafeInteger(scope[key]) || scope[key] < 1
      : typeof scope[key] !== "string" ||
        !/^[a-zA-Z0-9._:-]{1,160}$/.test(scope[key]),
  ) ||
  scope.runtimeProductId !== "codex" ||
  scope.runtimeBuildId !== SHA ||
  scope.adapterId !== "codex-acp-stdio-v1"
)
  throw Error("Invalid owned launch scope");
const digest = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
if (
  digest(realpathSync(launch.binary)) !== SHA ||
  digest(new URL(import.meta.url)) !== scope.adapterBuildId
)
  throw Error("Fixed build mismatch");
for (const [name, sha] of [
  [
    "./admission.mjs",
    "8b26fe2184078fd26fe91cfc9b9798733b974ba80c9824325bd3e631b71bc825",
  ],
  [
    "./interactions.mjs",
    "6046eaba46f6840eeb634c3cc15e37f9041022f40d821106ff7018b1d0421ed6",
  ],
  [
    "./turns.mjs",
    "5660670d07ef1574f9b522ac91fbcdcc54dc17bb7a4629eefafb713c4f71e8ff",
  ],
  [
    "./core.mjs",
    "f61726d21ae992c7fe9409cacda81794638fdf6e5ac60477b67102e3cc6d31a8",
  ],
  [
    "./configure.mjs",
    "741efc417116b703686f21da1be10f5fe2f38bb49aa51bd3e3833e119a4cab1f",
  ],
  [
    "./threads.mjs",
    "ccb9a64d786448b519fb36702fa3e77f1514aee39cb6786e3542638b03d52359",
  ],
  [
    "./events.mjs",
    "8b3a557046073a057a87f7ce8641ba452a926f2ab2836795322cada433a433ec",
  ],
]) {
  if (digest(new URL(name, import.meta.url)) !== sha)
    throw Error("Adapter module build mismatch");
}
for (const path of [launch.home, launch.codexHome, launch.cwd]) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    realpathSync(path) !== path
  )
    throw Error("Invalid owned directory");
}
if (
  launch.codexHome !== join(launch.home, "codex") ||
  lstatSync(launch.home).mode & 0o077 ||
  lstatSync(launch.codexHome).mode & 0o077
)
  throw Error("Private profile required");
// This skeleton never reads an existing authentication/configuration domain.
for (const name of ["auth.json", "config.toml", "sessions"]) {
  try {
    lstatSync(join(launch.codexHome, name));
    throw Error("Non-empty profile not admitted in this slice");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const native = spawn(
  launch.binary,
  [
    "app-server",
    "--listen",
    "stdio://",
    "-c",
    'cli_auth_credentials_store="file"',
    "-c",
    "features.default_mode_request_user_input=false",
    "-c",
    "check_for_update_on_startup=false",
  ],
  {
    cwd: launch.cwd,
    stdio: ["pipe", "pipe", "ignore"],
    env: {
      HOME: launch.home,
      CODEX_HOME: launch.codexHome,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HTTPS_PROXY: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "",
    },
  },
);
const { serveAdapter } = await import("./core.mjs");
serveAdapter({
  native,
  launch,
  version: VERSION,
  authenticationEnabled: false,
  threadMutationEnabled: false,
  tasksEnabled: false,
  interactionsEnabled: false,
  admissionEnabled: false,
});
