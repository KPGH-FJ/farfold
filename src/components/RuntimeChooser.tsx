import { ArrowsLeftRight } from "@phosphor-icons/react";

export type RuntimeProduct = "pi" | "opencode";

interface RuntimeChooserProps {
  value: RuntimeProduct;
  disabled: boolean;
  onChange: (runtime: RuntimeProduct) => void;
}

const runtimeCapabilities = {
  pi: {
    label: "Pi",
    version: "0.84.3",
    base: "yes",
    contributes: "yes",
    uses: "yes",
  },
  opencode: {
    label: "OpenCode",
    version: "1.15.13",
    base: "yes",
    contributes: "yes",
    uses: "yes",
  },
} as const;

export function RuntimeChooser({
  value,
  disabled,
  onChange,
}: RuntimeChooserProps) {
  const current = runtimeCapabilities[value];
  return (
    <div className="runtime-chooser">
      <label>
        <ArrowsLeftRight size={13} aria-hidden="true" />
        <span className="sr-only">Agent Runtime</span>
        <select
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value as RuntimeProduct)}
          aria-label="选择 Agent Runtime"
        >
          <option value="pi">Pi · 0.84.3</option>
          <option value="opencode">OpenCode · 1.15.13</option>
        </select>
      </label>
      <span className="runtime-version" aria-hidden="true">
        {current.label}
      </span>
      <div
        className="runtime-capabilities"
        aria-label={`${current.label} capabilities: Base=${current.base}, Contributes=${current.contributes}, Uses=${current.uses}`}
      >
        <span className={current.base === "yes" ? "verified" : "unverified"}>
          Base={current.base}
        </span>
        <span className={current.contributes === "yes" ? "verified" : "off"}>
          Contributes={current.contributes}
        </span>
        <span className={current.uses === "yes" ? "verified" : "off"}>
          Uses={current.uses}
        </span>
      </div>
    </div>
  );
}
