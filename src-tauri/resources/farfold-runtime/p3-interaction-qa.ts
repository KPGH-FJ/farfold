import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function registerP3InteractionQa(pi: ExtensionAPI) {
  pi.registerCommand("farfold-p3qa-confirm", {
    description:
      "Exercise the Pi-native RPC confirmation channel without an LLM turn",
    handler: async (_args, ctx) => {
      const confirmed = await ctx.ui.confirm(
        "P3 Runtime 原生交互检查",
        "这个确认框由 Pi Extension 通过官方 RPC UI 通道发起，不会调用 Provider。",
      );
      ctx.ui.notify(
        confirmed ? "P3 QA：原生确认已接受" : "P3 QA：原生确认已拒绝",
        confirmed ? "info" : "warning",
      );
    },
  });
}
