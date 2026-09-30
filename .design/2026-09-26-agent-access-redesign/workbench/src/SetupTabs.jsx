import React from "react";

const panels = [
  ["account", "账号与服务"],
  ["model", "模型"],
  ["program", "程序"],
];

export default function SetupTabs({ value, onChange, programReady }) {
  return (
    <div className="setup-tabs" role="tablist" aria-label="Agent 设置分类">
      {panels.map(([id, label]) => (
        <button
          type="button"
          role="tab"
          key={id}
          id={`setup-tab-${id}`}
          aria-controls={`setup-panel-${id}`}
          aria-selected={value === id}
          tabIndex={value === id ? 0 : -1}
          disabled={id !== "program" && !programReady}
          title={id !== "program" && !programReady ? "先连接程序" : undefined}
          onClick={() => onChange(id)}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const available = Array.from(
              event.currentTarget.parentElement.querySelectorAll(
                '[role="tab"]:not(:disabled)',
              ),
            );
            const current = available.indexOf(event.currentTarget);
            const index =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? available.length - 1
                  : (current +
                      (event.key === "ArrowRight" ? 1 : -1) +
                      available.length) %
                    available.length;
            available[index].focus();
            available[index].click();
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
