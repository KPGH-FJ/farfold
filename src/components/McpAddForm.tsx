import { useEffect, useRef, useState } from "react";
import type {
  InventoryOwner,
  InventoryResult,
} from "../runtime/extension_inventory_controller";
import { skillManagement } from "../runtime/skill_management_controller";
import { mcpAddInputError, type McpAddInput } from "../runtime/mcp_add_types";
import { MCP_ADD_STRINGS as S } from "../runtime/mcp_add_strings";
import "./McpAddForm.css";
type Draft = { inputId: string; input: McpAddInput };
export function McpAddForm({
  owner,
  result,
  enabled,
  current,
  changed,
}: {
  owner: InventoryOwner;
  result: InventoryResult;
  enabled: boolean;
  current(): boolean;
  changed(): void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [invalidated, setInvalidated] = useState(false);
  const live = useRef<{
    owner: InventoryOwner;
    result: InventoryResult;
    draft: Draft | null;
    open: boolean;
  }>({ owner, result, draft, open });
  live.current = { owner, result, draft, open };
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) heading.current?.focus();
    else if (wasOpen.current) opener.current?.focus();
    wasOpen.current = open;
  }, [open]);
  useEffect(
    () => () => {
      const old = live.current;
      if (old.owner === owner && old.draft)
        skillManagement.retireAddition(owner, old.draft.inputId);
    },
    [owner, result],
  );
  const valid = () =>
    enabled &&
    current() &&
    owner.current() &&
    live.current.owner === owner &&
    live.current.result === result;
  const edit = (input: McpAddInput) => {
    if (
      !valid() ||
      !draft ||
      live.current.draft !== draft ||
      !live.current.open
    )
      return;
    const prior = skillManagement.get(owner.agentId).request;
    const hadInspection =
      prior?.action === "inspect" &&
      "kind" in prior.target &&
      prior.target.kind === "mcpAddition" &&
      prior.target.inputId === draft.inputId;
    skillManagement.retireAddition(owner, draft.inputId);
    const next = { inputId: crypto.randomUUID(), input };
    live.current = { owner, result, draft: next, open: true };
    setDraft(next);
    setInvalidated((previous) => previous || hadInspection);
  };
  const close = () => {
    if (live.current.owner !== owner || live.current.result !== result) return;
    if (draft) skillManagement.retireAddition(owner, draft.inputId);
    live.current = { owner, result, draft: null, open: false };
    setOpen(false);
    setDraft(null);
    setInvalidated(false);
  };
  const error = draft ? mcpAddInputError(draft.input) : null;
  return (
    <section className="mcp-add-form" aria-label={S.form}>
      {!open ? (
        <button
          ref={opener}
          type="button"
          className="btn btn-ghost"
          disabled={!enabled}
          onClick={() => {
            if (!valid()) return;
            const next = {
              inputId: crypto.randomUUID(),
              input: { name: "", executablePath: "", args: [] },
            };
            live.current = { owner, result, draft: next, open: true };
            setDraft(next);
            setOpen(true);
          }}
        >
          {S.open}
        </button>
      ) : (
        draft && (
          <>
            <div className="skill-change-header">
              <h5 ref={heading} tabIndex={-1}>
                {S.heading}
              </h5>
              <button type="button" className="btn btn-ghost" onClick={close}>
                {S.cancelForm}
              </button>
            </div>
            <p>{S.guidance}</p>
            <p>{S.secrets}</p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (
                  !valid() ||
                  error ||
                  live.current.draft !== draft ||
                  !live.current.open
                )
                  return;
                const captured = draft;
                const accepted = skillManagement.inspect({
                  kind: "mcpAddition",
                  owner,
                  result,
                  inputId: captured.inputId,
                  input: captured.input,
                  current: () =>
                    current() &&
                    owner.current() &&
                    live.current.owner === owner &&
                    live.current.result === result &&
                    live.current.draft === captured &&
                    live.current.open,
                  changed,
                });
                if (accepted) setInvalidated(false);
              }}
            >
              <label>
                {S.name}
                <input
                  aria-label={S.name}
                  value={draft.input.name}
                  disabled={!enabled}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) =>
                    edit({ ...draft.input, name: event.currentTarget.value })
                  }
                />
              </label>
              <label>
                {S.executable}
                <input
                  aria-label={S.executable}
                  value={draft.input.executablePath}
                  disabled={!enabled}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) =>
                    edit({
                      ...draft.input,
                      executablePath: event.currentTarget.value,
                    })
                  }
                />
              </label>
              <fieldset disabled={!enabled}>
                <legend>{S.arguments}</legend>
                {draft.input.args.length === 0 && <p>{S.noArguments}</p>}
                {draft.input.args.map((arg, index) => (
                  <div className="mcp-add-argument" key={index}>
                    <label>
                      {S.argument} {index + 1}
                      <input
                        aria-label={`${S.argument} ${index + 1}`}
                        value={arg}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) =>
                          edit({
                            ...draft.input,
                            args: draft.input.args.map((a, i) =>
                              i === index ? event.currentTarget.value : a,
                            ),
                          })
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      aria-label={`${S.removeArgument} ${index + 1}`}
                      onClick={() =>
                        edit({
                          ...draft.input,
                          args: draft.input.args.filter((_, i) => i !== index),
                        })
                      }
                    >
                      {S.removeArgument}
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={draft.input.args.length >= 64}
                  onClick={() =>
                    edit({ ...draft.input, args: [...draft.input.args, ""] })
                  }
                >
                  {S.addArgument}
                </button>
              </fieldset>
              {error && <p role="status">{S.errors[error]}</p>}
              {invalidated && <p role="status">{S.invalidated}</p>}
              <button
                type="submit"
                className="btn btn-primary"
                disabled={!enabled || !!error}
              >
                {S.inspectButton}
              </button>
            </form>
          </>
        )
      )}
    </section>
  );
}
