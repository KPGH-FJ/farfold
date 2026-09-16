// Test-only dependency injection. Production entry has no synthetic launch flag.
import { spawn } from "node:child_process";
import { serveAdapter } from "../core.mjs";
const launch = JSON.parse(process.env.FARFOLD_TEST_LAUNCH);
const native = spawn(
  process.execPath,
  [
    new URL("./synthetic-server.mjs", import.meta.url).pathname,
    process.argv[2] ?? "waiting",
  ],
  {
    env: {
      HOME: launch.home,
      CODEX_HOME: launch.codexHome,
      PATH: "/usr/bin:/bin",
    },
    cwd: launch.cwd,
    stdio: ["pipe", "pipe", "ignore"],
  },
);
serveAdapter({
  native,
  launch,
  version: "0.1.5",
  authenticationEnabled: true,
  threadMutationEnabled: true,
  tasksEnabled: true,
  interactionsEnabled: true,
  admissionEnabled: true,
});
