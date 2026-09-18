// QA-only Pi extension. Installed temporarily in the isolated Dev agent dir.
// This exercises the official native UI protocol, without a Provider request.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export default function (pi) {
  pi.registerCommand("farfold-qa-dialog", {
    description: "QA 原生交互（不请求 Provider）",
    handler: async (args, ctx) => {
      if (!ctx.cwd.endsWith("/ai.farfold.desktop.dev/qa-projects/pi")) {
        ctx.ui.notify("QA fixture refuses this working directory", "warning");
        return;
      }
      const mode = args.trim();
      let result;
      switch (mode) {
        case "confirm":
        case "cancel":
          result = await ctx.ui.confirm(
            "QA 原生确认",
            "只记录本次原生回复，不请求 Provider。",
          );
          break;
        case "timeout":
          result = await ctx.ui.confirm(
            "QA 原生超时",
            "等待原生超时返回 false。",
            { timeout: 3000 },
          );
          break;
        case "select":
          result = await ctx.ui.select("QA 原生选择", ["甲", "乙"]);
          break;
        case "input":
          result = await ctx.ui.input("QA 原生输入", "请输入 QA-中文-42");
          break;
        case "editor":
          result = await ctx.ui.editor(
            "QA 原生编辑",
            "原生预填第一行\n原生预填第二行",
          );
          break;
        default:
          ctx.ui.notify(
            "QA fixture requires an explicit supported mode",
            "warning",
          );
          return;
      }
      await writeFile(
        join(ctx.cwd, `native-dialog-${mode}.json`),
        JSON.stringify({ mode, result: result ?? null }) + "\n",
        { mode: 0o600 },
      );
      ctx.ui.notify(
        `QA 原生回传 ${mode}: ${JSON.stringify(result ?? null)}`,
        "info",
      );
    },
  });
}
