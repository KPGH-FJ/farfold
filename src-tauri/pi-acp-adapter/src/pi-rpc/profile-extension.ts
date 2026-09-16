import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Embedded in the verified adapter bundle; no additional executable download or SDK Agent loop.
export function createProfileExtension(originalLeafId?: string) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'farfold-pi-profile-'))
  const command = `farfold-profile-${randomBytes(24).toString('hex')}`
  const restoreCommand = `${command}-restore`
  const firstUseCommand = `${command}-first-use`
  const prefix = `${command}:`
  const path = join(directory, 'profile.mjs')
  const dispose = () => rmSync(directory, { recursive: true, force: true })
  try {
    chmodSync(directory, 0o700)
    writeFileSync(
      path,
      `import { buildSessionContext } from "@earendil-works/pi-coding-agent";
export default function(pi) {
  pi.registerCommand(${JSON.stringify(command)}, {
    description: "Farfold internal profile refresh",
    handler: async (args, ctx) => {
      if (!/^[a-f0-9]{48}$/.test(args)) return;
      const before = { pid: process.pid, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() };
      let success = false;
      try {
        await ctx.modelRegistry.refresh({ allowNetwork: false });
        success = true;
      } catch { /* Native credential errors must not cross the control boundary. */ }
      ctx.ui.notify(${JSON.stringify(prefix)} + JSON.stringify({
        nonce: args, success, before,
        after: { pid: process.pid, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() }
      }), "info");
    }
  });
  pi.registerCommand(${JSON.stringify(restoreCommand)}, {
    description: "Farfold internal restored-model observation",
    handler: async (args, ctx) => {
      if (!/^[a-f0-9]{48}$/.test(args)) return;
      const before = { pid: process.pid, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() };
      let success = false;
      let restoredModel = null;
      let currentModel = null;
      let firstUse = null;
      let originalLeafRetained = false;
      let failureReason = "parser_unavailable";
      try {
        if (typeof buildSessionContext !== "function") throw new Error();
        failureReason = "history_unavailable";
        const entries = ctx.sessionManager.getEntries();
        const history = buildSessionContext(entries, ctx.sessionManager.getLeafId());
        const branch = ctx.sessionManager.getBranch();
        const originalLeaf = ${JSON.stringify(originalLeafId ?? null)};
        if (originalLeaf !== null) {
          const index = branch.findIndex(entry => entry.id === originalLeaf);
          originalLeafRetained = index >= 0 && branch.slice(index + 1).every(entry =>
            entry.type === "model_change" || entry.type === "thinking_level_change");
        }
        for (let i = branch.length - 1; i >= 0; i--) {
          const entry = branch[i];
          if (entry && entry.type === "custom" && entry.customType === "farfold-native-first-use-v1") {
            firstUse = entry.data;
            break;
          }
        }
        if (history.model) restoredModel = { provider: history.model.provider, modelId: history.model.modelId };
        if (ctx.model) currentModel = { provider: ctx.model.provider, modelId: ctx.model.id };
        success = true;
      } catch { /* Do not expose native history, authentication errors or exception details. */ }
      ctx.ui.notify(${JSON.stringify(prefix)} + JSON.stringify({
        nonce: args, operation: "restore", success, before, restoredModel, currentModel, firstUse, originalLeafRetained, failureReason: success ? null : failureReason,
        after: { pid: process.pid, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() }
      }), "info");
    }
  });
  pi.registerCommand(${JSON.stringify(firstUseCommand)}, {
    description: "Farfold internal native first-use state",
    handler: async (args, ctx) => {
      const match = /^([a-f0-9]{48}) ([A-Za-z0-9_-]{1,1024})$/.exec(args);
      if (!match) return;
      const before = { pid: process.pid, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() };
      let success = false;
      let firstUse = null;
      try {
        firstUse = JSON.parse(Buffer.from(match[2], "base64url").toString("utf8"));
        const keys = Object.keys(firstUse);
        const pending = firstUse && firstUse.version === 1 &&
          (firstUse.phase === "authentication_required" || firstUse.phase === "model_selection_required") &&
          keys.every(key => key === "version" || key === "phase");
        const ready = firstUse && firstUse.version === 1 && firstUse.phase === "ready" &&
          typeof firstUse.provider === "string" && firstUse.provider.length > 0 && firstUse.provider.length <= 200 && !firstUse.provider.includes("/") &&
          typeof firstUse.modelId === "string" && firstUse.modelId.length > 0 && (firstUse.provider + "/" + firstUse.modelId).length <= 512 &&
          keys.every(key => ["version", "phase", "provider", "modelId"].includes(key));
        if (!pending && !ready) throw new Error();
        pi.appendEntry("farfold-native-first-use-v1", firstUse);
        success = true;
      } catch { firstUse = null; }
      ctx.ui.notify(${JSON.stringify(prefix)} + JSON.stringify({
        nonce: match[1], operation: "first_use", success, firstUse, before,
        after: { pid: process.pid, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() }
      }), "info");
    }
  });
}
`,
      { mode: 0o600, flag: 'wx' }
    )
  } catch {
    dispose()
    throw new Error('Could not prepare the private Pi profile extension')
  }
  return { command, restoreCommand, firstUseCommand, prefix, path, dispose }
}

export type ProfileExtension = ReturnType<typeof createProfileExtension>
