import React, { useEffect, useState } from "react";
import { Modal, Button } from "./ui";

export function sendingScopes({ folder, tasks = [], workPolicies = {} }) {
  const draftLocation = folder || "普通对话";
  const locations = new Set([
    "普通对话",
    draftLocation,
    ...tasks.map((task) => task.folder || "普通对话"),
    ...Object.keys(workPolicies).filter(Boolean),
  ]);
  return [...locations].map((location) => ({
    location,
    currentDraft: location === draftLocation,
    tasks: tasks.filter((task) => (task.folder || "普通对话") === location),
  }));
}

export default function WorkPolicyDialog({
  modal,
  setModal,
  folder,
  tasks = [],
  workPolicies = {},
  setWorkPolicies,
}) {
  const [confirmLocation, setConfirmLocation] = useState(null);
  const [result, setResult] = useState("");
  useEffect(() => {
    if (modal !== "work-policy") {
      setConfirmLocation(null);
      setResult("");
    }
  }, [modal]);
  const scopes = sendingScopes({ folder, tasks, workPolicies });
  const selected = scopes.find((scope) => scope.location === confirmLocation);
  const close = () => {
    setConfirmLocation(null);
    setResult("");
    setModal(null);
  };
  return (
    <>
      {modal === "work-policy" && (
        <Modal
          title="消息发送管理"
          onClose={close}
          footer={
            selected ? (
              <>
                <Button onClick={() => setConfirmLocation(null)}>返回</Button>
                <Button
                  primary
                  onClick={() => {
                    setWorkPolicies((policies) => ({
                      ...policies,
                      [selected.location]: false,
                    }));
                    setResult(`已暂停 ${selected.location} 的消息发送。`);
                    setConfirmLocation(null);
                  }}
                >
                  暂停发送
                </Button>
              </>
            ) : (
              <Button onClick={close}>完成</Button>
            )
          }
        >
          {selected ? (
            <>
              <h3 style={{ overflowWrap: "anywhere" }}>{selected.location}</h3>
              <p>暂停后，以下对话和之后在此位置新建的对话都不能发送消息。</p>
              <ul style={{ paddingLeft: 20, margin: "18px 0" }}>
                {selected.currentDraft && <li>当前新对话草稿</li>}
                {selected.tasks.map((task) => (
                  <li key={task.id} style={{ overflowWrap: "anywhere" }}>
                    {task.title || "未命名对话"}
                    {task.archived ? "（已归档）" : ""}
                  </li>
                ))}
                {!selected.currentDraft && !selected.tasks.length && (
                  <li>此位置目前没有对话或草稿</li>
                )}
              </ul>
              <p className="set-caption">
                进行中的任务不会停止。仍可处理审批或停止任务。
              </p>
            </>
          ) : (
            <>
              <p>按位置暂停新消息。进行中的任务和审批不受影响。</p>
              {result && <p role="status">{result}</p>}
              <div className="workbench-policy-list">
                {scopes.map(({ location, currentDraft, tasks: affected }) => (
                  <div key={location}>
                    <span>
                      <strong>{location}</strong>
                      <small>
                        {workPolicies[location] === false ? "已暂停 · " : ""}
                        {affected.length} 段对话
                        {currentDraft ? " · 当前新对话草稿" : ""}
                      </small>
                    </span>
                    <Button
                      style={{ flexShrink: 0 }}
                      aria-label={`${workPolicies[location] === false ? "恢复发送" : "暂停发送"} ${location}`}
                      onClick={() => {
                        setResult("");
                        if (workPolicies[location] === false) {
                          setWorkPolicies((policies) => ({
                            ...policies,
                            [location]: true,
                          }));
                          setResult(
                            `已恢复 ${location} 的消息发送。待发内容不会自动发送。`,
                          );
                        } else setConfirmLocation(location);
                      }}
                    >
                      {workPolicies[location] === false
                        ? "恢复发送"
                        : "暂停发送"}
                    </Button>
                  </div>
                ))}
              </div>
              <small>恢复后，待发内容仍需手动发送。</small>
            </>
          )}
        </Modal>
      )}
    </>
  );
}
