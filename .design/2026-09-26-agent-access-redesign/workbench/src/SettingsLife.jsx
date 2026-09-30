import React from "react";
import {
  BookOpen,
  ShieldCheck,
  SlidersHorizontal,
  Sparkle,
} from "@phosphor-icons/react";
import { PageHeading, Badge } from "./ui.jsx";
import "./settings-api-lifecycle.css";

export default function LifeModel() {
  return (
    <>
      <PageHeading
        title="LifeModel"
        description="由你决定哪些工作偏好值得保留。"
      />
      <section className="settings-life-boundary">
        <Sparkle size={28} />
        <h2>当前尚未启用</h2>
        <Badge>产品说明</Badge>
        <p>
          现有版本尚未接通偏好采集、批准和对话使用。本页保留说明，不提供模拟开关或宣称偏好已保存、已发送。
        </p>
        <div className="settings-life-principles">
          <article>
            <BookOpen size={20} />
            <div>
              <strong>有来源依据</strong>
              <p>未来的偏好候选需要保留原话和上下文。</p>
            </div>
          </article>
          <article>
            <ShieldCheck size={20} />
            <div>
              <strong>由你明确批准</strong>
              <p>未经批准的候选不能进入长期偏好。</p>
            </div>
          </article>
          <article>
            <SlidersHorizontal size={20} />
            <div>
              <strong>使用范围可检查</strong>
              <p>采集和交付能力需要另行实现与验证，本轮不演示已完成。</p>
            </div>
          </article>
        </div>
      </section>
    </>
  );
}
