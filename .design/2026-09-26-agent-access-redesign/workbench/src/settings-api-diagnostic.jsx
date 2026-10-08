import React, { useEffect, useRef, useState } from "react";
import {
  CheckCircle,
  CircleNotch,
  Clock,
  X,
  WarningCircle,
} from "@phosphor-icons/react";
import { Button, Field } from "./ui.jsx";
import { createDiagnosticScope } from "./api-editor-state.js";

export default function ApiDiagnostic({
  models = [],
  ready = true,
  contextKey = "",
}) {
  const [model, setModel] = useState(models[0] || "");
  const [outcome, setOutcome] = useState("success");
  const [result, setResult] = useState(null);
  const scope = useRef(createDiagnosticScope());
  const timer = useRef(null);
  const effective = models.includes(model) ? model : models[0] || "";
  useEffect(() => {
    scope.current.invalidate();
    clearTimeout(timer.current);
    setResult(null);
    return () => {
      scope.current.invalidate();
      clearTimeout(timer.current);
    };
  }, [contextKey, effective, ready]);
  function start() {
    if (!ready || !effective || result?.kind === "busy") return;
    const id = scope.current.begin(),
      selectedModel = effective;
    setResult({ kind: "busy", model: selectedModel });
    timer.current = setTimeout(() => {
      if (!scope.current.finish(id)) return;
      setResult({ kind: outcome, model: selectedModel });
    }, 750);
  }
  function cancel() {
    scope.current.invalidate();
    clearTimeout(timer.current);
    setResult({ kind: "cancelled", model: effective });
  }
  const copy = {
    success: [
      CheckCircle,
      "此模型的演示响应完整",
      "API 诊断通过；尚未交给 Agent 使用。",
    ],
    failed: [
      WarningCircle,
      "演示密钥未被接受",
      "检查地址和密钥后手动重试，当前输入保留。",
    ],
    limited: [
      WarningCircle,
      "响应达到上限",
      "未取得完整回复，不能标为测试通过。",
    ],
    timeout: [Clock, "等待响应超时", "本次等待已结束，不会自动重复请求。"],
    cancelled: [X, "已取消本次等待", "迟到结果不会恢复成功提示。"],
  };
  const detail = copy[result?.kind];
  const Icon = detail?.[0];
  return (
    <section className="set-api-test">
      <div className="set-section-title">
        <h3>测试一个模型（可选）</h3>
        <small>只验证本次选择，不代表已被 Agent 选用</small>
      </div>
      <div className="set-test-controls">
        <Field label="测试模型">
          <select
            aria-label="API 诊断模型"
            disabled={result?.kind === "busy"}
            value={effective}
            onChange={(e) => {
              scope.current.invalidate();
              setModel(e.target.value);
              setResult(null);
            }}
          >
            {!models.length && <option value="">请先添加模型</option>}
            {models.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </Field>
        {result?.kind === "busy" ? (
          <Button onClick={cancel}>取消测试</Button>
        ) : (
          <Button disabled={!ready || !effective} onClick={start}>
            {result ? "重新测试" : "测试 API"}
          </Button>
        )}
      </div>
      {result && (
        <div role="status" className={`set-test-result ${result.kind}`}>
          {result.kind === "busy" ? (
            <>
              <CircleNotch size={18} className="spin" />
              <span>正在模拟 {result.model} 的响应…</span>
            </>
          ) : (
            <>
              <Icon size={19} />
              <div>
                <strong>{detail[1]}</strong>
                <p>
                  {result.model} · {detail[2]}
                </p>
                {result.kind === "success" && <code>OK</code>}
              </div>
            </>
          )}
        </div>
      )}
      <details className="settings-api-review">
        <summary>诊断演示选项</summary>
        <Field label="下次诊断结果">
          <select
            aria-label="API 测试演示结果"
            value={outcome}
            disabled={result?.kind === "busy"}
            onChange={(e) => setOutcome(e.target.value)}
          >
            <option value="success">完整响应</option>
            <option value="failed">密钥被拒绝</option>
            <option value="limited">响应被截断</option>
            <option value="timeout">服务超时</option>
          </select>
        </Field>
        <p>只运行本地演示，不读取密钥、不发送网络请求或项目内容。</p>
      </details>
    </section>
  );
}
