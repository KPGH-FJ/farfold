import { useState } from "react";
import type { AgentsState } from "../runtime/agents";
import { STRINGS } from "../runtime/strings";
import { AgentAuthSection } from "./AgentAuthSection";
import { AgentCard } from "./AgentCard";

interface CustomFormState {
  open: boolean;
  name: string;
  command: string;
  args: string;
  submitting: boolean;
}

const emptyCustomForm: CustomFormState = {
  open: false,
  name: "",
  command: "",
  args: "",
  submitting: false,
};

export function AgentAccessSettings({ agents }: { agents: AgentsState }) {
  const [form, setForm] = useState<CustomFormState>(emptyCustomForm);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const submitCustom = async () => {
    const args = form.args
      .split(/\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
    setForm((prev) => ({ ...prev, submitting: true }));
    const ok = await agents.addCustom({
      name: form.name,
      command: form.command,
      args,
    });
    setForm(ok ? emptyCustomForm : { ...form, submitting: false });
  };

  return (
    <>
      <div className="s-head-row">
        <div>
          <div className="s-h">{STRINGS.agents.heading}</div>
          <div className="s-sub">{STRINGS.agents.sub}</div>
        </div>
        <button
          type="button"
          className="btn btn-ghost s-rescan"
          disabled={agents.scanning}
          onClick={() => void agents.rescan()}
        >
          {agents.scanning ? STRINGS.agents.rescanning : STRINGS.agents.rescan}
        </button>
      </div>

      {agents.errors.__scan && (
        <div className="ac-error" role="alert">
          {agents.errors.__scan}
        </div>
      )}
      {agents.errors.__custom && (
        <div className="ac-error" role="alert">
          {agents.errors.__custom}
        </div>
      )}

      {agents.cards.map((card) => (
        <AgentCard
          key={card.id}
          card={card}
          busy={agents.busy[card.id] ?? null}
          error={agents.errors[card.id] ?? null}
          workOn={agents.workEnabled(card.id)}
          confirmRemove={confirmRemoveId === card.id}
          onConnect={() => void agents.connect(card)}
          onDisconnect={() => void agents.disconnect(card.id)}
          onRemove={() => {
            if (confirmRemoveId === card.id) {
              setConfirmRemoveId(null);
              void agents.remove(card.id);
            } else {
              setConfirmRemoveId(card.id);
            }
          }}
          onToggleWork={(on) => agents.setWorkEnabled(card.id, on)}
          authSection={
            <AgentAuthSection
              agentId={card.id}
              onChanged={agents.refresh}
              onReconnect={() => agents.reconnect(card)}
            />
          }
        />
      ))}

      <div className="agent-card custom-card">
        <div className="ac-head">
          <span className="id unknown">?</span>
          <span className="ac-name">{STRINGS.agents.custom.title}</span>
        </div>
        <div className="ac-desc">{STRINGS.agents.custom.desc}</div>
        {form.open ? (
          <div className="custom-form">
            <input
              className="custom-input"
              value={form.name}
              placeholder={STRINGS.agents.custom.namePlaceholder}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, name: event.target.value }))
              }
            />
            <input
              className="custom-input"
              value={form.command}
              placeholder={STRINGS.agents.custom.commandPlaceholder}
              spellCheck={false}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, command: event.target.value }))
              }
            />
            <input
              className="custom-input"
              value={form.args}
              placeholder={STRINGS.agents.custom.argsPlaceholder}
              spellCheck={false}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, args: event.target.value }))
              }
            />
            <div className="ac-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  form.submitting || !form.name.trim() || !form.command.trim()
                }
                onClick={() => void submitCustom()}
              >
                {STRINGS.agents.custom.submit}
              </button>
              <button
                type="button"
                className="btn btn-text"
                disabled={form.submitting}
                onClick={() => setForm(emptyCustomForm)}
              >
                {STRINGS.agents.custom.cancel}
              </button>
            </div>
          </div>
        ) : (
          <div className="ac-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setForm((prev) => ({ ...prev, open: true }))}
            >
              {STRINGS.agents.custom.add}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
