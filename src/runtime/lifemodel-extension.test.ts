import { describe, expect, it } from "vitest";
import extensionSource from "../../src-tauri/resources/farfold-runtime/lifemodel-context.ts?raw";

describe("bundled LifeModel Extension boundary", () => {
  it("does not run a session-start side effect or occupy the prompt channel", () => {
    expect(extensionSource).not.toContain('pi.on("session_start"');
    expect(extensionSource).not.toContain("ctx.sessionManager.getLeafId()");
    expect(extensionSource).not.toContain(
      'registerCommand("farfold-lifemodel-anchor"',
    );
    expect(extensionSource).toContain(
      'registerCommand("farfold-lifemodel-context"',
    );
    expect(extensionSource).toContain(
      'registerCommand("farfold-lifemodel-clear"',
    );
  });
});
