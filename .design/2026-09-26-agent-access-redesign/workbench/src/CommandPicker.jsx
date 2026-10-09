import React, { useState } from "react";
import { Button, Modal } from "./ui";
import { COMMAND_EXAMPLES, filterCommands } from "./composer-examples.js";
export default function CommandPicker({ onClose, onSelect }) {
  const [query, setQuery] = useState("");
  const results = filterCommands(COMMAND_EXAMPLES, query);
  return (
    <Modal
      title="Agent 命令示例"
      onClose={onClose}
      className="complete-command-dialog"
      footer={<Button onClick={onClose}>返回输入</Button>}
    >
      <p className="v2-help">
        下面是布局与交互样例。正式使用时只显示 Agent
        实际提供的命令。选择仅填入输入框，保留已有内容，不会发送。
      </p>
      <label className="complete-search">
        查找命令
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索名称或描述"
        />
      </label>
      <p role="status">
        {results.length} / {COMMAND_EXAMPLES.length} 条演示命令
      </p>
      <div className="complete-command-list">
        {results.map((item) => (
          <article key={item.name}>
            <strong>{item.name}</strong>
            <p>{item.description}</p>
            <Button
              onClick={() => onSelect(item.name)}
              aria-label={`填入 ${item.name}`}
            >
              填入命令
            </Button>
          </article>
        ))}
      </div>
      {!results.length && (
        <p>
          没有匹配的命令。<Button onClick={() => setQuery("")}>清除搜索</Button>
        </p>
      )}
    </Modal>
  );
}
