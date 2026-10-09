import { CommandIcon } from "@phosphor-icons/react";
import {
  promptTemplates,
  type PromptTemplate,
} from "../runtime/prompt_templates";
import { PROMPT_TEMPLATES as S } from "../runtime/prompt_template_strings";
import { COMPOSER_CONTROLS as C } from "../runtime/composer_strings";

export function isCurrentTemplateText(text: string): boolean {
  if (C.shortcuts.some((item) => item.text === text)) return true;
  const current = promptTemplates.snapshot();
  return (
    current.ready &&
    !current.uncertain &&
    current.items.some((item) => item.text === text)
  );
}

export function ComposerTemplateActions({
  items,
  builtins,
  error,
  onInsert,
  onManage,
}: {
  items: PromptTemplate[];
  builtins: readonly { label: string; text: string }[];
  error: boolean;
  onInsert: (text: string) => void;
  onManage: () => void;
}) {
  return (
    <>
      <span className="composer-shortcuts-title">{C.shortcutsHint}</span>
      {builtins.map((item) => (
        <button
          key={item.label}
          type="button"
          className="btn btn-ghost"
          onClick={() => onInsert(item.text)}
        >
          <CommandIcon size={15} />
          <span>{item.label}</span>
        </button>
      ))}
      {!!items.length && (
        <span className="composer-shortcuts-title">{S.group}</span>
      )}
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="btn btn-ghost"
          onClick={() => onInsert(item.text)}
        >
          <CommandIcon size={15} />
          <span>{item.label}</span>
        </button>
      ))}
      {error && <p role="status">{S.errorStatus}</p>}
      <button type="button" className="btn btn-ghost" onClick={onManage}>
        {S.manage}
      </button>
    </>
  );
}
