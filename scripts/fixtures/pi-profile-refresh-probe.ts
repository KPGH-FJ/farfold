interface ProfileProbeContext {
  modelRegistry: {
    refresh(options: { allowNetwork: boolean }): Promise<unknown>;
  };
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
  };
  ui: { notify(message: string, level: "info"): void };
}

interface ProfileProbeApi {
  registerCommand(
    name: string,
    options: {
      description: string;
      handler(args: string, context: ProfileProbeContext): Promise<void>;
    },
  ): void;
}

export default function (pi: ProfileProbeApi) {
  pi.registerCommand("farfold-profile-probe", {
    description: "Isolated model-free profile refresh verification",
    handler: async (args, context) => {
      if (args === "refresh") {
        await context.modelRegistry.refresh({ allowNetwork: false });
      }
      context.ui.notify(
        `D-PROFILE-PROBE:${JSON.stringify({
          pid: process.pid,
          sessionId: context.sessionManager.getSessionId(),
          sessionFile: context.sessionManager.getSessionFile(),
        })}`,
        "info",
      );
    },
  });
}
