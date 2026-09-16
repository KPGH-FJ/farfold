import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

it("correlates native Pi login cancellation without saving credentials or hiding a real rejection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "farfold-login-"));
  let child;
  let lines;
  let timer;
  try {
    child = spawn(
      resolve("src-tauri/capability-bridge/runtime/node"),
      [resolve("src-tauri/capability-bridge/bridge.mjs")],
      {
        env: { ...process.env, FARFOLD_PI_AGENT_DIR: directory },
      },
    );
    const closed = once(child, "close");
    timer = setTimeout(() => child.kill(), 10_000);
    child.stderr.resume();
    lines = createInterface({ input: child.stdout });
    const result = new Promise((done, fail) => {
      const responses = new Map();
      child.once("error", fail);
      child.once("close", () =>
        fail(new Error("Pi bridge exited before login responses")),
      );
      lines.on("line", (line) => {
        try {
          const event = JSON.parse(line);
          if (event.type === "auth_prompt" && event.requestId === "login-qa") {
            expect(event.providerId).toBe("zai");
            child.stdin.write(
              JSON.stringify({
                type: "auth_cancel",
                id: "cancel-qa",
                requestId: event.requestId,
              }) + "\n",
            );
          }
          if (event.type === "response") {
            responses.set(event.id, event);
            if (
              responses.has("login-qa") &&
              responses.has("cancel-qa") &&
              responses.has("bad-login")
            )
              done(responses);
          }
        } catch (reason) {
          fail(reason);
        }
      });
    });
    child.stdin.write(
      JSON.stringify({
        type: "login",
        id: "login-qa",
        providerId: "zai",
        authType: "api_key",
      }) + "\n",
    );
    // A second concurrent login is a real rejection, never a cancellation.
    child.stdin.write(
      JSON.stringify({
        type: "login",
        id: "bad-login",
        providerId: "zai",
        authType: "api_key",
      }) + "\n",
    );
    const responses = await result;
    child.stdin.end();
    await closed;
    expect(responses.get("cancel-qa").data.cancelled).toBe(true);
    expect(responses.get("login-qa")).toMatchObject({
      success: false,
      cancelled: true,
    });
    expect(responses.get("bad-login").success).toBe(false);
    expect(responses.get("bad-login").cancelled).not.toBe(true);
    const auth = await readFile(join(directory, "auth.json"), "utf8").catch(
      (reason) => {
        if (reason.code === "ENOENT") return "{}";
        throw reason;
      },
    );
    expect(JSON.parse(auth)).toEqual({});
  } finally {
    clearTimeout(timer);
    lines?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill();
      await closed;
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
