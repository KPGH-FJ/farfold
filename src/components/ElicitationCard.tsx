/**
 * elicitation/create（form 模式）表单卡：按 requestedSchema 渲染字段
 * （text/select/number/boolean/multi-select），提交或取消经
 * `session_elicitation_respond` 回给 Agent。
 */
import { useMemo } from "react";
import type { PendingElicitation } from "../runtime/session_types";
import { STRINGS } from "../runtime/strings";

interface FieldSpec {
  name: string;
  title: string;
  description?: string;
  required: boolean;
  /** text | number | boolean | select | multi */
  kind: "text" | "number" | "boolean" | "select" | "multi";
  choices: { value: string; label: string }[];
}

function choiceList(prop: Record<string, unknown>): FieldSpec["choices"] {
  const fromEnum = (raw: unknown): FieldSpec["choices"] =>
    Array.isArray(raw)
      ? raw.map((v) => ({ value: String(v), label: String(v) }))
      : [];
  if (Array.isArray(prop.enum)) return fromEnum(prop.enum);
  const union = (prop.oneOf ?? prop.anyOf) as
    Record<string, unknown>[] | undefined;
  if (Array.isArray(union)) {
    return union
      .filter((u) => u && u.const !== undefined)
      .map((u) => ({
        value: String(u.const),
        label: String(u.title ?? u.const),
      }));
  }
  return [];
}

function fieldsFromSchema(schema: Record<string, unknown> | null): FieldSpec[] {
  const properties = (schema?.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const required = new Set(
    Array.isArray(schema?.required)
      ? (schema.required as unknown[]).map(String)
      : [],
  );
  return Object.entries(properties).map(([name, prop]) => {
    const type = String(prop?.type ?? "string");
    const base = {
      name,
      title: String(prop?.title ?? name),
      description:
        typeof prop?.description === "string" ? prop.description : undefined,
      required: required.has(name),
      choices: [] as FieldSpec["choices"],
    };
    if (type === "boolean") return { ...base, kind: "boolean" as const };
    if (type === "number" || type === "integer") {
      return { ...base, kind: "number" as const };
    }
    if (type === "array") {
      const items = (prop?.items ?? {}) as Record<string, unknown>;
      const choices = choiceList(items);
      return choices.length > 0
        ? { ...base, kind: "multi" as const, choices }
        : { ...base, kind: "text" as const };
    }
    const choices = choiceList(prop ?? {});
    return choices.length > 0
      ? { ...base, kind: "select" as const, choices }
      : { ...base, kind: "text" as const };
  });
}

function Field({
  spec,
  value,
  onChange,
}: {
  spec: FieldSpec;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const label = (
    <span className="el-label">
      {spec.title}
      {spec.required && (
        <span className="el-req">{STRINGS.elicitation.requiredMark}</span>
      )}
    </span>
  );
  const desc = spec.description && (
    <span className="el-desc">{spec.description}</span>
  );
  switch (spec.kind) {
    case "boolean":
      return (
        <label className="el-field">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
          />
          {label}
          {desc}
        </label>
      );
    case "select":
      return (
        <label className="el-field">
          {label}
          {desc}
          <select
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="" disabled />
            {spec.choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      );
    case "multi":
      return (
        <div className="el-field">
          {label}
          {desc}
          <div className="el-multi">
            {spec.choices.map((c) => {
              const list = Array.isArray(value) ? (value as string[]) : [];
              const checked = list.includes(c.value);
              return (
                <label key={c.value} className="el-check">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) =>
                      onChange(
                        e.target.checked
                          ? [...list, c.value]
                          : list.filter((v) => v !== c.value),
                      )
                    }
                  />
                  {c.label}
                </label>
              );
            })}
          </div>
        </div>
      );
    case "number":
      return (
        <label className="el-field">
          {label}
          {desc}
          <input
            type="number"
            value={typeof value === "number" ? value : ""}
            onChange={(e) =>
              onChange(
                e.target.value === "" ? undefined : Number(e.target.value),
              )
            }
          />
        </label>
      );
    default:
      return (
        <label className="el-field">
          {label}
          {desc}
          <input
            type="text"
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
      );
  }
}

export function ElicitationCard({
  request: elicitation,
  onChange,
  onRespond,
  disabled = false,
  statusLabel,
}: {
  request: PendingElicitation;
  disabled?: boolean;
  statusLabel?: string;
  onChange: (name: string, value: unknown) => void;
  onRespond: (
    action: "accept" | "cancel",
    values?: Record<string, unknown>,
  ) => void;
}) {
  const fields = useMemo(
    () => fieldsFromSchema(elicitation?.schema ?? null),
    [elicitation?.schema],
  );
  const values = elicitation.values;
  const locked = disabled || elicitation.status !== "pending";

  const missingRequired = fields.some(
    (f) =>
      f.required &&
      f.kind !== "boolean" &&
      (values[f.name] === undefined ||
        values[f.name] === "" ||
        (Array.isArray(values[f.name]) &&
          (values[f.name] as unknown[]).length === 0)),
  );

  const respond = (action: "accept" | "cancel") => {
    if (locked) return;
    const content: Record<string, unknown> = {};
    for (const field of fields) {
      const v = values[field.name];
      if (field.kind === "boolean" && (field.required || v !== undefined))
        content[field.name] = v === true;
      else if (v !== undefined && v !== "") content[field.name] = v;
    }
    onRespond(action, action === "accept" ? content : undefined);
  };

  return (
    <div className="approval elicitation">
      <div className="tag">
        <i />
        {statusLabel ?? STRINGS.elicitation.needYou}
      </div>
      <div className="ap-title">
        {elicitation.message || STRINGS.elicitation.untitled}
      </div>
      {elicitation.error && (
        <div className="auth-note" role="alert">
          {elicitation.error}
        </div>
      )}
      <fieldset
        className="el-form"
        disabled={locked}
        style={{ margin: 0, padding: 0, border: 0, minWidth: 0 }}
      >
        {fields.map((field) => (
          <Field
            key={field.name}
            spec={field}
            value={values[field.name]}
            onChange={(v) => onChange(field.name, v)}
          />
        ))}
      </fieldset>
      <div className="ap-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={locked || missingRequired}
          onClick={() => respond("accept")}
        >
          {elicitation.status === "submitting"
            ? STRINGS.repair.interactionSubmitting
            : STRINGS.elicitation.submit}
        </button>
        <button
          type="button"
          className="btn btn-text"
          disabled={locked}
          onClick={() => respond("cancel")}
        >
          {STRINGS.elicitation.cancel}
        </button>
      </div>
    </div>
  );
}
