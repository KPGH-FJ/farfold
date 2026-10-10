import { useEffect, useRef, useState, type RefObject } from "react";
import type {
  InventoryOwner,
  InventoryResult,
} from "../runtime/extension_inventory_controller";
import { skillManagement } from "../runtime/skill_management_controller";
import {
  isHttpInput,
  mcpAddInputError,
  type McpAddInput,
} from "../runtime/mcp_add_types";
import {
  MCP_ADD_STRINGS as S,
  MCP_HTTP_ADD_STRINGS as H,
} from "../runtime/mcp_add_strings";
import "./McpAddForm.css";
type Draft = {
  owner: InventoryOwner;
  result: InventoryResult;
  inputId: string;
  input: McpAddInput;
};
type Live = {
  owner: InventoryOwner;
  result: InventoryResult;
  draft: Draft | null;
  open: boolean;
  allowed(): boolean;
};
// Defined outside render: the retained permission callback has no captured Draft/URL.
function inputCurrent(
  live: RefObject<Live>,
  owner: InventoryOwner,
  result: InventoryResult,
  inputId: string,
) {
  return () =>
    live.current.owner === owner &&
    live.current.result === result &&
    live.current.open &&
    live.current.draft?.inputId === inputId &&
    live.current.allowed() &&
    owner.current();
}
export function McpAddForm({
  owner,
  result,
  enabled,
  current,
  changed,
  httpAvailable = false,
  stdioAvailable = true,
}: {
  owner: InventoryOwner;
  result: InventoryResult;
  enabled: boolean;
  current(): boolean;
  changed(): void;
  httpAvailable?: boolean;
  stdioAvailable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [stored, setDraft] = useState<Draft | null>(null);
  const draft =
    stored?.owner === owner && stored.result === result ? stored : null;
  const [invalidated, setInvalidated] = useState(false);
  const live = useRef<Live>({ owner, result, draft, open, allowed: current });
  live.current = {
    owner,
    result,
    draft,
    open: open && !!draft,
    allowed: current,
  };
  const ownership = useRef({ owner, result, inputId: null as string | null });
  if (ownership.current.owner !== owner || ownership.current.result !== result)
    ownership.current = { owner, result, inputId: null };
  const heading = useRef<HTMLHeadingElement>(null),
    opener = useRef<HTMLButtonElement>(null),
    wasOpen = useRef(false);
  useEffect(() => {
    if (open) heading.current?.focus();
    else if (wasOpen.current) opener.current?.focus();
    wasOpen.current = open;
  }, [open]);
  useEffect(() => {
    const owned = ownership.current;
    setDraft((value) =>
      value?.owner === owner && value.result === result ? value : null,
    );
    return () => {
      const old = live.current;
      if (owned.inputId)
        skillManagement.retireAddition(
          owner,
          owned.inputId,
          old.owner === owner && old.result !== result,
        );
      if (
        old.owner === owner &&
        old.result === result &&
        old.draft?.inputId === owned.inputId
      ) {
        live.current = { ...old, draft: null, open: false };
        setDraft(null);
        setOpen(false);
      }
    };
  }, [owner, result]);
  useEffect(
    () =>
      skillManagement.subscribe(() => {
        const old = live.current,
          value = old.draft;
        if (!value || !isHttpInput(value.input)) return;
        const view = skillManagement.get(old.owner.agentId),
          request = view.request;
        if (
          request &&
          "inputId" in request.target &&
          request.target.inputId === value.inputId &&
          view.additionInput === null
        ) {
          live.current = { ...old, draft: null, open: false };
          setDraft(null);
          setOpen(false);
        }
      }),
    [],
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
      "inputId" in prior.target &&
      prior.target.inputId === draft.inputId;
    skillManagement.retireAddition(owner, draft.inputId);
    const next = { owner, result, inputId: crypto.randomUUID(), input };
    ownership.current.inputId = next.inputId;
    live.current = { owner, result, draft: next, open: true, allowed: current };
    setDraft(next);
    setOpen(true);
    setInvalidated((previous) => previous || hadInspection);
  };
  const close = () => {
    if (live.current.owner !== owner || live.current.result !== result) return;
    if (draft) skillManagement.retireAddition(owner, draft.inputId);
    live.current = {
      owner,
      result,
      draft: null,
      open: false,
      allowed: current,
    };
    setOpen(false);
    setDraft(null);
    setInvalidated(false);
  };
  const httpInput = draft && isHttpInput(draft.input) ? draft.input : null;
  const localInput = draft && !isHttpInput(draft.input) ? draft.input : null;
  const copy = httpInput ? H : S;
  const error = draft ? mcpAddInputError(draft.input) : null;
  return (
    <section
      className="mcp-add-form"
      aria-label={httpAvailable ? H.form : S.form}
    >
      {!open || !draft ? (
        <button
          ref={opener}
          type="button"
          className="btn btn-ghost"
          disabled={!enabled}
          onClick={() => {
            if (!valid()) return;
            const next: Draft = {
              owner,
              result,
              inputId: crypto.randomUUID(),
              input: stdioAvailable
                ? { name: "", executablePath: "", args: [] }
                : { transport: "streamableHttp", name: "", url: "" },
            };
            ownership.current.inputId = next.inputId;
            live.current = {
              owner,
              result,
              draft: next,
              open: true,
              allowed: current,
            };
            setDraft(next);
            setOpen(true);
          }}
        >
          {httpAvailable ? H.open : S.open}
        </button>
      ) : (
        <>
          <div className="skill-change-header">
            <h5 ref={heading} tabIndex={-1}>
              {copy.heading}
            </h5>
            <button type="button" className="btn btn-ghost" onClick={close}>
              {S.cancelForm}
            </button>
          </div>
          <p>{copy.guidance}</p>
          <p>{copy.secrets}</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (
                !valid() ||
                error ||
                live.current.draft !== draft ||
                !live.current.open ||
                (httpInput ? !httpAvailable : !stdioAvailable)
              )
                return;
              const accepted = skillManagement.inspect({
                kind: "mcpAddition",
                owner,
                result,
                inputId: draft.inputId,
                input: draft.input,
                httpAvailable,
                current: inputCurrent(live, owner, result, draft.inputId),
                changed,
              });
              if (accepted) setInvalidated(false);
            }}
          >
            {httpAvailable && (
              <label>
                {H.transport}
                <select
                  aria-label={H.transport}
                  value={httpInput ? "streamableHttp" : "stdio"}
                  disabled={!enabled}
                  onChange={(event) => {
                    const mode = event.currentTarget.value;
                    if (mode === "streamableHttp" && httpAvailable)
                      edit({
                        transport: "streamableHttp",
                        name: draft.input.name,
                        url: "",
                      });
                    else if (mode === "stdio" && stdioAvailable)
                      edit({
                        name: draft.input.name,
                        executablePath: "",
                        args: [],
                      });
                  }}
                >
                  {stdioAvailable && <option value="stdio">{H.local}</option>}
                  <option value="streamableHttp">{H.http}</option>
                </select>
              </label>
            )}
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
            {httpInput && (
              <label>
                {H.address}
                <input
                  aria-label={H.address}
                  type="text"
                  value={httpInput.url}
                  disabled={!enabled}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  onChange={(event) =>
                    edit({ ...httpInput, url: event.currentTarget.value })
                  }
                />
              </label>
            )}
            {localInput && (
              <>
                <label>
                  {S.executable}
                  <input
                    aria-label={S.executable}
                    value={localInput.executablePath}
                    disabled={!enabled}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) =>
                      edit({
                        ...localInput,
                        executablePath: event.currentTarget.value,
                      })
                    }
                  />
                </label>
                <fieldset disabled={!enabled}>
                  <legend>{S.arguments}</legend>
                  {localInput.args.length === 0 && <p>{S.noArguments}</p>}
                  {localInput.args.map((arg, index) => (
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
                              ...localInput,
                              args: localInput.args.map((a, i) =>
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
                            ...localInput,
                            args: localInput.args.filter((_, i) => i !== index),
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
                    disabled={localInput.args.length >= 64}
                    onClick={() =>
                      edit({ ...localInput, args: [...localInput.args, ""] })
                    }
                  >
                    {S.addArgument}
                  </button>
                </fieldset>
              </>
            )}
            {error && <p role="status">{H.errors[error]}</p>}
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
      )}
    </section>
  );
}
