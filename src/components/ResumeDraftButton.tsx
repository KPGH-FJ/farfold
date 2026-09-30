import { useComposerDraft } from "../runtime/drafts";
import { LIBRARY } from "../runtime/library_strings";

export function ResumeDraftButton({ onClick }: { onClick?: () => void }) {
  const draft = useComposerDraft("new");
  if (!onClick || (!draft.text.trim() && !draft.attachments.length))
    return null;
  return (
    <button type="button" className="resume-draft-button" onClick={onClick}>
      {LIBRARY.continueDraft}
    </button>
  );
}
