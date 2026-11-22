import { useEffect, useRef, useState } from "react";
import { savedOfficialReadOnlyTarget } from "../runtime/official_readonly_check";
import { OFFICIAL_READONLY_CHECK_STRINGS as S } from "../runtime/official_readonly_check_strings";
import { setupStorage } from "../runtime/setup_storage";
import { OfficialReadOnlyAttempt } from "./AgentOfficialReadOnlyCheck";
import { useConnectionPreparation } from "./useConnectionPreparation";

/** The saved settings check owns no ordinary preparation session or draft. */
export function useAgentSetupSavedCheck({
  agentId,
  program,
  cwd,
  step,
  eligible,
}: {
  agentId: string;
  program: string;
  cwd?: string | null;
  step: number;
  eligible: boolean;
}) {
  const saved = eligible ? setupStorage.confirmedSelection(agentId) : undefined;
  const config = saved && !saved.service ? saved.config : undefined;
  const { info } = useConnectionPreparation(agentId, program, false, !!config);
  const target =
    config && cwd
      ? savedOfficialReadOnlyTarget(
          agentId,
          cwd,
          info?.officialReadOnlyCheck,
          config,
        )
      : null;
  const owner = target ? JSON.stringify([program, step, target]) : "";
  const [opened, setOpened] = useState("");
  const open = !!owner && opened === owner;
  const opener = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (opened && !open) setOpened("");
    if (open) heading.current?.focus();
    else if (restoreFocus.current) {
      restoreFocus.current = false;
      opener.current?.focus();
    }
  }, [open, opened]);
  const back = () => {
    restoreFocus.current = true;
    setOpened("");
  };
  return {
    open,
    back,
    entry: target && !open && (
      <button
        ref={opener}
        type="button"
        className="btn btn-ghost"
        onClick={() => setOpened(owner)}
      >
        {S.savedTitle}
      </button>
    ),
    panel: open && target && (
      <section
        className="agent-setup-body"
        aria-labelledby="agent-saved-model-heading"
      >
        <h3 id="agent-saved-model-heading" ref={heading} tabIndex={-1}>
          {S.savedTitle}
        </h3>
        <p>
          {S.savedModel} {target.model}
        </p>
        <p>
          {S.savedReasoning} {target.reasoningEffort}
        </p>
        <OfficialReadOnlyAttempt key={owner} target={target} open />
        <button type="button" className="btn btn-ghost" onClick={back}>
          {S.back}
        </button>
      </section>
    ),
  };
}
