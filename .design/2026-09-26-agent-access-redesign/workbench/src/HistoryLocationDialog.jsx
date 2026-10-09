import React from "react";
import { Modal, Button } from "./ui";
export default function HistoryLocationDialog({
  task,
  newLocation,
  setNewLocation,
  onClose,
  onStart,
}) {
  return (
    <Modal title="选择新对话的工作位置" onClose={() => onClose()}>
      <div className="flow-folder-picker">
        <p>
          原对话“{task.title}
          ”仍保留原来的设置。这里为新对话选择一个示例位置，不移动或重新连接旧历史。
        </p>
        <label htmlFor="new-location">新对话的文件夹</label>
        <select
          id="new-location"
          value={newLocation}
          onChange={(e) => setNewLocation(e.target.value)}
        >
          <option value="">不选文件夹 · 普通对话</option>
          <option value="~/Projects/farfold">~/Projects/farfold · 示例</option>
          <option value="~/Documents/Notes">~/Documents/Notes · 示例</option>
        </select>
        <small>
          选择的是工作位置，不代表文件访问权限边界。本原型不会打开真实文件。
        </small>
        <footer>
          <Button onClick={() => onClose()}>取消</Button>
          <Button
            primary
            onClick={() => {
              onStart(task, newLocation);
            }}
          >
            进入新对话
          </Button>
        </footer>
      </div>
    </Modal>
  );
}
