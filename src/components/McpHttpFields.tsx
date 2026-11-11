import type { McpHttpInput } from "../runtime/mcp_add_types";
import { MCP_HTTP_ADD_STRINGS as S } from "../runtime/mcp_add_strings";

/** Shared input only; the caller owns review, scope and the operation's effects. */
export function McpHttpFields({
  input,
  disabled,
  onChange,
}: {
  input: McpHttpInput;
  disabled: boolean;
  onChange(input: McpHttpInput): void;
}) {
  return (
    <>
      <label>
        {S.name}
        <input
          aria-label={S.name}
          value={input.name}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) =>
            onChange({ ...input, name: event.currentTarget.value })
          }
        />
      </label>
      <label>
        {S.address}
        <input
          aria-label={S.address}
          type="text"
          value={input.url}
          disabled={disabled}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          onChange={(event) =>
            onChange({ ...input, url: event.currentTarget.value })
          }
        />
      </label>
    </>
  );
}
