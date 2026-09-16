interface ProbeContext {
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    input(
      title: string,
      placeholder: string,
      options?: { timeout: number },
    ): Promise<string | undefined>;
    editor(title: string, prefill: string): Promise<string | undefined>;
    setStatus(key: string, text: string): void;
    setWidget(key: string, lines: string[]): void;
    setTitle(title: string): void;
    setEditorText(text: string): void;
    notify(message: string, level: "info"): void;
  };
}

interface ProbeExtensionApi {
  registerCommand(
    name: string,
    options: {
      description: string;
      handler(args: string, ctx: ProbeContext): Promise<void>;
    },
  ): void;
}

export default function (pi: ProbeExtensionApi) {
  pi.registerCommand("farfold-d-timeout", {
    description: "Isolated native dialog timeout",
    handler: async (_args, ctx) => {
      const value = await ctx.ui.input("D timeout", "No answer", {
        timeout: 100,
      });
      ctx.ui.notify(
        `D-TIMEOUT-RESULT:${JSON.stringify(value ?? null)}`,
        "info",
      );
    },
  });
  pi.registerCommand("farfold-d-probe", {
    description: "Isolated, model-free ACP candidate comparison",
    handler: async (_args, ctx) => {
      const selected = await ctx.ui.select("D select", ["One", "Two"]);
      const confirmed = await ctx.ui.confirm("D confirm", "Continue?");
      const input = await ctx.ui.input("D input", "Enter text");
      const editor = await ctx.ui.editor("D editor", "Original text");
      ctx.ui.setStatus("d-probe", "D status");
      ctx.ui.setWidget("d-probe", ["D widget"]);
      ctx.ui.setTitle("D title");
      ctx.ui.setEditorText("D draft");
      ctx.ui.notify(
        `D-PROBE-RESULT:${JSON.stringify({
          selected: selected ?? null,
          confirmed,
          input: input ?? null,
          editor: editor ?? null,
        })}`,
        "info",
      );
    },
  });
}
