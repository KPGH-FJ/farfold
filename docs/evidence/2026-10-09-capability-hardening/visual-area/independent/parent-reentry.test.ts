import { expect, it, vi } from "vitest";
vi.mock("react", () => ({ useRef: (value: unknown) => ({ current: value }) }));
import { useFileFeedbackTargets } from "../../../../../src/components/useFileFeedbackTargets";
import {
  registerVisualFeedbackFrame,
  createVisualAreaFeedbackSource,
  visualAreaFeedbackTarget,
  type VisualTargetConfirmation,
} from "../../../../../src/runtime/visual_feedback_target";

it("rechecks parent edit eligibility after current-renderer validation", () => {
  const file = {
    root: "/controlled",
    path: "a.png",
    resolvedPath: "/controlled/a.png",
    name: "a.png",
    size: 8,
    sha256: "a".repeat(64),
    version: "v1",
  };
  const preview = { file, mimeType: "image/png", data: "Y29udHJvbGw=" };
  let canEdit = true;
  let reenter = false;
  const frame = registerVisualFeedbackFrame({
    kind: "image",
    preview,
    expectedFile: file,
    drawOwner: {},
    pixelWidth: 800,
    pixelHeight: 600,
    isCurrent: () => {
      if (reenter) canEdit = false;
      return true;
    },
  })!;
  const source = createVisualAreaFeedbackSource({
    frame,
    selection: { left: 1, top: 2, right: 700000, bottom: 800000 },
    expectedFile: file,
  })!;
  const anchor = visualAreaFeedbackTarget(source)!;
  const apply = vi.fn();
  const targets = useFileFeedbackTargets({
    identity: "controlled",
    canEdit: () => canEdit,
    acceptsText: () => false,
    acceptsOffice: () => false,
    acceptsVisual: () => true,
    acceptsEditing: () => true,
    visualPreview: () => preview,
    apply,
  });
  targets.reportVisual({ source, available: true });
  reenter = true;
  targets.confirmVisual({ source, anchor } as VisualTargetConfirmation);
  expect(canEdit).toBe(false);
  expect(apply).not.toHaveBeenCalled();
});
