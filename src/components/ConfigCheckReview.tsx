import type { ConfigCheck } from "../runtime/config_check";
import type { ConfigOptionView } from "../runtime/session_types";

/** Rendering never replaces the opaque snapshot that the user confirms. */
export function ConfigCheckReview({
  check,
  options,
}: {
  check: ConfigCheck | null;
  options: ConfigOptionView[];
}) {
  if (
    !check ||
    !["confirmation_required", "record_failed"].includes(check.status)
  )
    return null;
  if (!check.current || typeof check.current !== "object") return null;
  const current = check.current as Record<string, unknown>;
  const v2 = Array.isArray(current.choices);
  const choices = v2
    ? (current.choices as unknown[])
    : [current.model, current.thoughtLevel];
  const rows = choices.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const choice = raw as Record<string, unknown>;
    if (
      typeof choice.id !== "string" ||
      typeof choice.value !== "string" ||
      (v2 && choice.type !== "select")
    )
      return [];
    const option = options.find((item) => item.id === choice.id);
    const label =
      option?.options.find((item) => item.value === choice.value)?.name ??
      choice.value;
    return [{ id: choice.id, name: option?.name ?? choice.id, label }];
  });
  if (!rows.length) return null;
  return (
    <dl className="config-guard-choices">
      {rows.map((row, index) => (
        <div key={`${row.id}:${index}`}>
          <dt>{row.name}</dt>
          <dd>{row.label}</dd>
        </div>
      ))}
    </dl>
  );
}
