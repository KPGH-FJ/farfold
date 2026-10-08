import React, { useState } from "react";
import {
  Globe,
  X,
  SidebarSimple,
  ArrowRight,
  ShieldCheck,
} from "@phosphor-icons/react";
import { Button, Modal } from "./ui";
import { demoPage, webpageEvent } from "./conversation-content-state.js";

export default function ConversationWebPanel({ task, onTaskChange }) {
  const page = { url: demoPage, granted: false, ...task.webPreview };
  const [address, setAddress] = useState(page.url);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const act = (action, url) =>
    onTaskChange({ webPreview: webpageEvent(page, action, url) });
  return (
    <aside className="cr-web-panel" aria-label="网页内容栏">
      <header>
        <Globe size={18} />
        <strong>网页</strong>
        <Button
          kind="icon"
          aria-label="收起网页，保留许可"
          title="收起网页，保留许可"
          onClick={() => act("hide")}
        >
          <SidebarSimple size={18} />
        </Button>
        <Button
          kind="icon"
          aria-label="关闭网页并撤回许可"
          title="关闭网页并撤回许可"
          onClick={() => act("close")}
        >
          <X size={18} />
        </Button>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          try {
            const parsed = new URL(address);
            if (!["http:", "https:"].includes(parsed.protocol))
              throw new Error();
            setError("");
            act("navigate", parsed.href);
          } catch {
            setError("请输入以 https:// 或 http:// 开头的网址。");
          }
        }}
      >
        <input
          aria-label="网页地址（演示）"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
        <Button type="submit" aria-label="打开此示例地址">
          <ArrowRight size={16} />
        </Button>
      </form>
      <div className="cr-web-scope">
        <ShieldCheck size={17} />
        <span>
          {page.granted
            ? `仅允许 ${task.agent} 读取当前页面`
            : "正在查看 · 尚未分享给 Agent"}
        </span>
      </div>
      {error && (
        <p role="alert" className="cr-state-note">
          {error}
        </p>
      )}
      <article className="cr-web-document">
        <small>静态示例 · 不访问网络</small>
        <h2>给想法留一点空间</h2>
        <p>从问题出发，整理现有材料，再决定要继续探索的方向。</p>
        <hr />
        <h3>准备一份清晰的研究笔记</h3>
        <p>记录事实，保留来源，让问题和下一步行动一目了然。</p>
        <p>
          此内容用于演示：打开网页只供你查看；Agent 读取时，仍需要单独确认范围。
        </p>
        <code>{page.url}</code>
      </article>
      <footer>
        <p>收起内容栏保留页面与许可。关闭或换页会撤回。</p>
        <Button
          onClick={() => (page.granted ? act("revoke") : setConfirm(true))}
        >
          {page.granted ? "撤回本页读取许可" : "体验 Agent 请求读取"}
        </Button>
        {page.message && <p role="status">{page.message}</p>}
      </footer>
      {confirm && (
        <Modal
          title="允许读取当前页面？"
          onClose={() => setConfirm(false)}
          footer={
            <>
              <Button onClick={() => setConfirm(false)}>暂不允许</Button>
              <Button
                primary
                onClick={() => {
                  act("grant");
                  setConfirm(false);
                }}
              >
                仅允许本页 · 演示
              </Button>
            </>
          }
        >
          <p>
            {task.agent}{" "}
            请求读取此页面，用于回答你的问题。这是工具请求的确认演示。
          </p>
          <div className="cr-source-summary">
            <strong>本次范围</strong>
            <span>{page.url}</span>
            <small>仅当前页面；不允许点击、填写表单或读取其他页面。</small>
          </div>
          <p>
            换页、关闭或连接结束后撤回许可。撤回不会删除已经交给 Agent 的内容。
          </p>
        </Modal>
      )}
    </aside>
  );
}
