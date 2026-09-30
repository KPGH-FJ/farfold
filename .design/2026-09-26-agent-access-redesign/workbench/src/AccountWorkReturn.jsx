import React from "react";
import { Button } from "./ui.jsx";

export default function AccountWorkReturn({ target, onReturn }) {
  return (
    <div
      className="account-work-return"
      role="region"
      aria-label="账号设置返回"
    >
      <span>
        正在处理 {target} 的账号操作限制。处理后返回继续，草稿已保留。
      </span>
      <Button onClick={onReturn}>返回 {target} 账号设置</Button>
    </div>
  );
}
