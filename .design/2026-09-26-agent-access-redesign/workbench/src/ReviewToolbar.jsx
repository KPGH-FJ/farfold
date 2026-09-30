import React from "react";
import { ArrowCounterClockwise } from "@phosphor-icons/react";
export default function ReviewToolbar({ pendingSend, setModal, storageIssue }) {
  return (
    <div className="v2-review-bar">
      <div>
        <strong>FARFOLD · 交互原型</strong>
        <span>模拟数据 · 不执行真实安装、登录或请求</span>
      </div>
      <div>
        <button disabled={pendingSend} onClick={() => setModal("examples")}>
          载入示例
        </button>
        <button onClick={() => setModal("review")}>设计说明</button>
        <button onClick={() => setModal("feedback")}>反馈</button>
        <button
          title={
            storageIssue
              ? "保存失败，请先复制内容"
              : "模拟关闭并重新打开；不会自动发送"
          }
          disabled={storageIssue}
          onClick={() => location.reload()}
        >
          重启演示
        </button>
        <button aria-label="重置演示" onClick={() => setModal("reset")}>
          <ArrowCounterClockwise size={14} />
        </button>
      </div>
    </div>
  );
}
