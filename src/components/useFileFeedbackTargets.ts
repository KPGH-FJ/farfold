import { useRef } from "react";
import type { VerifiedFile, VisualPreview } from "../runtime/file_delivery";
import type {
  FileFeedbackAnchor,
  TextRangeAnchor,
} from "../runtime/file_feedback_anchor";
import type { FileTargetEditing } from "../runtime/file_target_editing";
import { samePreviewFile } from "../runtime/preview_capture";
import {
  textFeedbackRangeMatches,
  type TextFeedbackSource,
} from "../runtime/text_feedback_range";
import {
  officeFeedbackTargetMatches,
  retireOfficeFeedbackSource,
  type OfficeFeedbackSource,
  type OfficeTargetAvailability,
  type OfficeTargetConfirmation,
} from "../runtime/office_feedback_target";
import {
  retireVisualAreaFeedbackSource,
  visualAreaFeedbackTargetMatches,
  type VisualAreaFeedbackSource,
  type VisualTargetAvailability,
  type VisualTargetConfirmation,
} from "../runtime/visual_feedback_target";

interface TargetPolicy {
  identity: string;
  canEdit: () => boolean;
  acceptsText: (source: TextFeedbackSource) => boolean;
  acceptsOffice: (source: OfficeFeedbackSource) => boolean;
  acceptsVisual: (source: VisualAreaFeedbackSource) => boolean;
  acceptsEditing: (file: Readonly<VerifiedFile>) => boolean;
  visualPreview: () => VisualPreview | undefined;
  apply: (anchor: FileFeedbackAnchor) => void;
}

/** Transient ownership only; the caller checks the actual read/operation state. */
export function useFileFeedbackTargets(policy: TargetPolicy) {
  const owner = useRef(policy.identity);
  const latestPolicy = useRef(policy);
  latestPolicy.current = policy;
  const text = useRef<TextFeedbackSource | null>(null);
  const office = useRef<OfficeFeedbackSource | null>(null);
  const visual = useRef<VisualAreaFeedbackSource | null>(null);
  const editing = useRef<{
    owner: object;
    file: Readonly<VerifiedFile>;
  } | null>(null);
  const retiredEditors = useRef(new WeakSet<object>());
  const clearText = () => {
    text.current = null;
  };
  const clearOffice = () => {
    if (office.current) retireOfficeFeedbackSource(office.current);
    office.current = null;
  };
  const clearVisual = () => {
    if (visual.current) retireVisualAreaFeedbackSource(visual.current);
    visual.current = null;
  };
  const clearEditing = () => {
    if (editing.current) retiredEditors.current.add(editing.current.owner);
    editing.current = null;
  };
  const clear = () => {
    clearText();
    clearOffice();
    clearVisual();
    clearEditing();
  };
  if (owner.current !== policy.identity) {
    clear();
    owner.current = policy.identity;
  }
  const owns = () => owner.current === policy.identity;
  const canApply = () =>
    owns() && latestPolicy.current === policy && policy.canEdit();
  const reportText = (value: {
    source: TextFeedbackSource;
    available: boolean;
  }) => {
    if (!owns()) return;
    if (!value.available) {
      if (text.current === value.source) clearText();
    } else if (policy.acceptsText(value.source) && canApply())
      text.current = value.source;
  };
  const confirmText = (value: {
    source: TextFeedbackSource;
    anchor: TextRangeAnchor;
  }) => {
    if (
      owns() &&
      policy.canEdit() &&
      policy.acceptsText(value.source) &&
      text.current === value.source &&
      textFeedbackRangeMatches(value.source, value.anchor) &&
      text.current === value.source &&
      canApply()
    )
      policy.apply(value.anchor);
  };
  const reportOffice = (value: OfficeTargetAvailability) => {
    if (!owns()) return;
    if (!value.available) {
      if (office.current === value.source) clearOffice();
    } else if (policy.acceptsOffice(value.source) && canApply()) {
      if (office.current !== value.source) clearOffice();
      office.current = value.source;
    }
  };
  const confirmOffice = (value: OfficeTargetConfirmation) => {
    if (
      owns() &&
      policy.canEdit() &&
      policy.acceptsOffice(value.source) &&
      office.current === value.source &&
      officeFeedbackTargetMatches(value) &&
      office.current === value.source &&
      canApply()
    )
      policy.apply(value.anchor);
  };
  const reportVisual = (value: VisualTargetAvailability) => {
    if (!owns()) return;
    if (!value.available) {
      if (visual.current === value.source) clearVisual();
    } else if (policy.acceptsVisual(value.source) && canApply()) {
      if (visual.current !== value.source) clearVisual();
      visual.current = value.source;
    }
  };
  const confirmVisual = (value: VisualTargetConfirmation) => {
    const preview = policy.visualPreview();
    if (
      owns() &&
      preview &&
      policy.canEdit() &&
      policy.acceptsVisual(value.source) &&
      visual.current === value.source &&
      visualAreaFeedbackTargetMatches(value, preview) &&
      policy.acceptsVisual(value.source) &&
      policy.visualPreview() === preview &&
      visual.current === value.source &&
      canApply()
    )
      policy.apply(value.anchor);
  };
  const reportEditing = (value: FileTargetEditing) => {
    if (!owns() || !value.owner || typeof value.owner !== "object") return;
    if (value.editing === false) {
      if (
        editing.current?.owner === value.owner &&
        !samePreviewFile(editing.current.file, value.file)
      )
        return;
      retiredEditors.current.add(value.owner);
      if (editing.current?.owner === value.owner) editing.current = null;
      return;
    }
    if (
      value.editing !== true ||
      retiredEditors.current.has(value.owner) ||
      !policy.canEdit() ||
      !policy.acceptsEditing(value.file) ||
      !canApply()
    )
      return;
    if (editing.current?.owner !== value.owner) clearEditing();
    editing.current = { owner: value.owner, file: { ...value.file } };
  };
  return {
    clear,
    clearText,
    clearOffice,
    clearVisual,
    clearEditing,
    reportText,
    confirmText,
    reportOffice,
    confirmOffice,
    reportVisual,
    confirmVisual,
    reportEditing,
    hasPendingSelection: () =>
      owns() &&
      Boolean(
        text.current || office.current || visual.current || editing.current,
      ),
  };
}
