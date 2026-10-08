import React, { useState, useRef, useEffect } from "react";
import {
  Globe,
  X,
  ArrowsOutSimple,
  SidebarSimple,
  LockSimple,
  ArrowRight,
} from "@phosphor-icons/react";
import { Button, Modal } from "./ui";

export default function DraftWebPreview({ onClose, scope }) {
  const [hidden, setHidden] = useState(false);
  const [address, setAddress] = useState("https://example.com/research-notes");
  const [page, setPage] = useState(address);
  const [granted, setGranted] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState("");
  const priorScope = useRef(scope);
  useEffect(() => {
    if (priorScope.current !== scope) {
      setGranted(false);
      setConfirm(false);
      setMessage("Agent、服务或工作位置已变化，原来的读取许可已撤回。");
      priorScope.current = scope;
    }
  }, [scope]);
  const navigate = () => {
    if (!/^https?:\/\//i.test(address)) {
      setMessage("输入以 https:// 或 http:// 开头的网址。");
      return;
    }
    setPage(address);
    setGranted(false);
    setMessage("已切换示例页面，上一个页面的读取许可已撤回。");
  };
  return (
    <aside
      className={"draft-web-panel" + (hidden ? " minimized" : "")}
      aria-label="草稿网页内容栏"
    >
      <header>
        <Globe size={17} />
        <strong>参考网页</strong>
        <span className={granted ? "web-permission granted" : "web-permission"}>
          {granted ? "允许读取本页" : "未分享给 Agent"}
        </span>
        <Button
          kind="icon"
          aria-label={hidden ? "展开网页" : "收起网页"}
          onClick={() => setHidden(!hidden)}
        >
          {hidden ? <ArrowsOutSimple size={17} /> : <SidebarSimple size={17} />}
        </Button>
        <Button kind="icon" aria-label="关闭网页并撤回许可" onClick={onClose}>
          <X size={17} />
        </Button>
      </header>
      {!hidden && (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              navigate();
            }}
          >
            <input
              aria-label="示例网页地址"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
            <Button aria-label="打开输入的示例网址" type="submit">
              <ArrowRight size={17} />
            </Button>
          </form>
          <div className="draft-web-document">
            <small>静态示例 · 没有访问网络</small>
            <h2>给想法留一点空间</h2>
            <p>从问题出发，整理现有材料，再决定要继续探索的方向。</p>
            <hr />
            <h3>准备一份清晰的研究笔记</h3>
            <p>
              记录事实、保留来源，让问题和下一步行动一目了然。这段内容用于体验网页查看和分享范围。
            </p>
          </div>
          <footer>
            <span>
              <LockSimple size={15} />
              查看页面不会自动交给 Agent。
            </span>
            <Button
              onClick={() =>
                granted
                  ? (setGranted(false),
                    setMessage("已撤回读取许可。网页仍然保留。"))
                  : setConfirm(true)
              }
            >
              {granted ? "撤回读取许可" : "体验本页读取确认"}
            </Button>
          </footer>
          {message && (
            <p role="status" className="draft-web-receipt">
              {message}
            </p>
          )}
        </>
      )}
      {confirm && (
        <Modal
          title="允许读取这个页面？"
          onClose={() => setConfirm(false)}
          footer={
            <>
              <Button onClick={() => setConfirm(false)}>暂不允许</Button>
              <Button
                primary
                onClick={() => {
                  setGranted(true);
                  setConfirm(false);
                  setMessage("已记录演示许可；未执行真实读取或发送消息。");
                }}
              >
                仅允许本页 · 演示
              </Button>
            </>
          }
        >
          <p>
            示例 Agent
            请求读取下方页面。收起页面保留许可；关闭、换页或连接结束会撤回。
          </p>
          <div className="selection-source-summary">
            <strong>本次读取范围</strong>
            <span>{page}</span>
          </div>
          <p>
            这是确认流程演示。正式产品须由真实工具请求触发，不能因打开网页就获得许可。
          </p>
        </Modal>
      )}
    </aside>
  );
}
