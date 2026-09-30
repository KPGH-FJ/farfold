import { Check } from "@phosphor-icons/react";
import { SETUP_PRESENTATION as P } from "../runtime/setup_presentation_strings";
import { AGENT_SETUP_STRINGS as M } from "../runtime/agent_setup_strings";

export function AgentSetupNavigation({
  manage,
  step,
  connected,
  onStep,
}: {
  manage: boolean;
  step: number;
  connected: boolean;
  onStep: (step: number) => void;
}) {
  if (!manage)
    return (
      <ol className="agent-setup-steps" aria-label={P.progress}>
        {P.stages.map((label, index) => (
          <li
            key={label}
            aria-current={index === step ? "step" : undefined}
            className={
              index === step
                ? "current"
                : connected && index < step
                  ? "complete"
                  : ""
            }
          >
            <span>
              {connected && index < step ? <Check size={13} /> : index + 1}
            </span>
            {label}
          </li>
        ))}
      </ol>
    );
  return (
    <div className="agent-setup-tabs" role="tablist" aria-label={P.tabs}>
      {[
        { step: 1, label: M.account },
        { step: 2, label: M.model },
        { step: 0, label: M.program },
      ].map((tab) => (
        <button
          type="button"
          role="tab"
          key={tab.step}
          id={`agent-setup-tab-${tab.step}`}
          aria-controls="agent-setup-panel"
          aria-selected={step === tab.step}
          tabIndex={step === tab.step ? 0 : -1}
          disabled={tab.step !== 0 && !connected}
          title={tab.step !== 0 && !connected ? M.goProgram : undefined}
          onClick={() => onStep(tab.step)}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const available = Array.from(
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                '[role="tab"]:not(:disabled)',
              ) ?? [],
            );
            const index = available.indexOf(event.currentTarget);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? available.length - 1
                  : (index +
                      (event.key === "ArrowRight" ? 1 : -1) +
                      available.length) %
                    available.length;
            available[next]?.focus();
            available[next]?.click();
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
