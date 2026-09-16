import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Composer } from "./Composer";

it("disables unsupported Stop without implying cancellation and restores ordinary Stop", () => {
  const props = {
    runtimeLabel: "Pi",
    supportsSteering: true,
    supportsFollowUp: true,
    steeringHint: "当前工具完成后应用",
    running: true,
    ready: true,
    working: true,
    submitting: false,
    stopping: false,
    message: "",
    delivery: "steer" as const,
    projectName: "fixture",
    contextPercent: null,
    commands: [],
    lifeModelItems: [],
    onMessage() {},
    onDelivery() {},
    onSend() {},
    onAbort() {},
    onRemoveLifeModelItem() {},
    onOpenLifeModel() {},
  };
  const unavailable = renderToStaticMarkup(
    <Composer {...props} stopUnavailableReason="固定 Pi 不支持停止手动压缩" />,
  );
  expect(unavailable).toMatch(/class="stop-button" disabled=""/);
  expect(unavailable).toContain("停止不可用");
  expect(unavailable).not.toContain("停止中…");
  const normal = renderToStaticMarkup(<Composer {...props} />);
  expect(normal).not.toMatch(/class="stop-button" disabled/);
  expect(normal).not.toContain("停止不可用");
});
