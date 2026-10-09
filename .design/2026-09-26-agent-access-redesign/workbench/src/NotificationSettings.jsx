import React, { useEffect, useRef, useState } from "react";
import { Bell, ArrowRight, ArrowClockwise, X } from "@phosphor-icons/react";
import { Badge, Button, Modal, Toggle } from "./ui.jsx";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_PERMISSION_LABELS,
  notificationPreferences,
  notificationPreviewBlock,
  notificationPreviewTargets,
  resolveNotificationTarget,
} from "./notification-preview-state.js";

export default function NotificationSettings({
  preferences,
  onChange,
  tasks = [],
  onOpenTask,
  saveFailed = false,
}) {
  const [localPreferences, setLocalPreferences] = useState(
    DEFAULT_NOTIFICATION_PREFERENCES,
  );
  const current = notificationPreferences(preferences ?? localPreferences);
  const [permission, setPermission] = useState("not-requested");
  const [dialog, setDialog] = useState(null);
  const [returnPermission, setReturnPermission] = useState("granted");
  const [checking, setChecking] = useState(false);
  const [selection, setSelection] = useState("multiple");
  const [previews, setPreviews] = useState([]);
  const [previewing, setPreviewing] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const ticket = useRef(0);
  const permissionTicket = useRef(0);
  const latest = useRef({ current, permission, tasks });
  latest.current = { current, permission, tasks };
  const block = notificationPreviewBlock(current, permission);
  const eligibleTasks = tasks.filter((task) => task.id && !task.archived);
  const selectedTaskMissing =
    selection !== "multiple" &&
    !eligibleTasks.some((task) => task.id === selection);

  useEffect(() => {
    if (!block) return;
    ticket.current++;
    setPreviewing(false);
    setPreviews([]);
  }, [block]);
  useEffect(
    () => () => {
      ticket.current++;
      permissionTicket.current++;
    },
    [],
  );

  const save = (patch) => {
    if (saveFailed) {
      setError("设置保存失败，仍保留之前的提醒偏好。请恢复本地保存后重试。");
      return false;
    }
    const next = { ...current, ...patch };
    try {
      if (onChange?.(next) === false) throw new Error("save-failed");
      if (!onChange) setLocalPreferences(next);
      setError("");
      setFeedback("提醒偏好已保存到原型。真实系统设置未改变。");
      return true;
    } catch {
      setError("设置保存失败，仍保留之前的提醒偏好。可以重试。");
      return false;
    }
  };
  const toggleEnabled = (enabled) => {
    if (!save({ enabled })) return;
    if (enabled && permission === "not-requested") setDialog("permission");
    if (!enabled) {
      ticket.current++;
      permissionTicket.current++;
      setChecking(false);
      setPreviewing(false);
      setPreviews([]);
      setDialog(null);
      setFeedback(
        "提醒已关闭，当前提醒预览已清除。声音偏好保留，之后开启时沿用。",
      );
    }
  };
  const changePermission = (next) => {
    permissionTicket.current++;
    ticket.current++;
    setChecking(false);
    setPreviewing(false);
    setPreviews([]);
    setPermission(next);
    setDialog(null);
    setFeedback(
      `模拟权限：${NOTIFICATION_PERMISSION_LABELS[next]}。未请求或修改真实系统权限。`,
    );
  };
  const closeDialog = () => {
    permissionTicket.current++;
    setChecking(false);
    setDialog(null);
  };
  const recheck = () => {
    const request = ++permissionTicket.current;
    setChecking(true);
    setTimeout(() => {
      if (request !== permissionTicket.current) return;
      changePermission(returnPermission);
    }, 650);
  };
  const showPreview = () => {
    const state = latest.current;
    if (notificationPreviewBlock(state.current, state.permission)) return;
    const selected = notificationPreviewTargets(state.tasks, selection);
    if (!selected.length) {
      setFeedback("没有可以定位的对话。请先从改版导览打开一个示例流程。");
      return;
    }
    const request = ++ticket.current;
    setPreviewing(true);
    setPreviews([]);
    setFeedback("正在生成本页提醒预览…");
    setTimeout(() => {
      const now = latest.current;
      if (
        request !== ticket.current ||
        notificationPreviewBlock(now.current, now.permission)
      )
        return;
      const available = selected.filter((item) =>
        now.tasks.some((task) => task.id === item.taskId),
      );
      setPreviews(available);
      setPreviewing(false);
      setFeedback(
        available.length
          ? `已展示 ${available.length} 条测试提醒。没有发送系统通知，也没有播放声音。`
          : "所选对话已不存在，没有生成提醒预览。",
      );
    }, 450);
  };

  return (
    <section
      id="settings-notifications"
      className="set-general-section notification-settings"
    >
      <div className="set-section-title">
        <h3>
          <Bell size={18} />
          提醒
        </h3>
        <Badge>原型演示</Badge>
      </div>
      <p className="notification-boundary">
        仅演示设置与提醒卡片，不请求系统权限、不播放声音、不发送桌面通知。
      </p>
      <div className="set-setting-row">
        <div>
          <strong>需要你时提醒</strong>
          <p>Agent 等待批准、提问或工作出现异常时提醒你；普通输出保持安静。</p>
        </div>
        <Toggle
          label="需要你时提醒"
          checked={current.enabled}
          onChange={toggleEnabled}
        />
      </div>
      <div className="set-setting-row">
        <div>
          <strong>提醒声音</strong>
          <p>
            {current.enabled
              ? "需要处理的提醒可附带声音。此处只保存偏好，不播放声音。"
              : "开启提醒后可以调整声音；关闭提醒时，已有声音偏好保留。"}
          </p>
        </div>
        <Toggle
          label="提醒声音"
          checked={current.sound}
          disabled={!current.enabled}
          onChange={(sound) => save({ sound })}
        />
      </div>
      <div className="notification-permission">
        <div>
          <strong>系统通知权限</strong>
          <span>模拟状态：{NOTIFICATION_PERMISSION_LABELS[permission]}</span>
          <p>
            {permission === "granted"
              ? "允许状态下可以体验下方测试提醒。真实系统仍需单独授权与验证。"
              : permission === "denied"
                ? "提醒偏好已保留。正式应用需要你到系统设置允许通知，才能显示桌面提醒。"
                : permission === "unavailable"
                  ? "当前环境无法使用系统通知。对话中的待处理提示仍然可见。"
                  : "打开提醒后，完成一次权限演示；取消不会被当作允许。"}
          </p>
        </div>
        {permission === "not-requested" ? (
          <Button
            disabled={!current.enabled}
            onClick={() => setDialog("permission")}
          >
            查看权限演示
          </Button>
        ) : (
          <Button onClick={() => setDialog("settings")}>
            {permission === "denied" ? "如何允许通知" : "检查系统权限"}
          </Button>
        )}
      </div>
      <div className="notification-test">
        <div>
          <strong>测试提醒</strong>
          <p>
            预览标题、Agent
            和待处理事项；点击卡片进入对应对话，不代替你批准或发送消息。
          </p>
        </div>
        <div className="notification-test-actions">
          <select
            aria-label="测试提醒对应对话"
            value={selection}
            onChange={(event) => setSelection(event.target.value)}
            disabled={!eligibleTasks.length || previewing}
          >
            <option value="multiple">多条提醒（最多 3 段对话）</option>
            {selectedTaskMissing && (
              <option value={selection}>先前所选对话已不存在</option>
            )}
            {eligibleTasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.agent} · {task.title}
              </option>
            ))}
          </select>
          <Button
            disabled={
              Boolean(block) ||
              !eligibleTasks.length ||
              previewing ||
              selectedTaskMissing
            }
            onClick={showPreview}
          >
            <Bell size={16} />
            {previewing ? "正在生成预览…" : "预览测试提醒"}
          </Button>
        </div>
        {block && <p className="notification-help">{block}</p>}
        {!eligibleTasks.length && (
          <p className="notification-help">
            当前没有可定位的对话。可从改版导览打开一个示例流程后回来测试。
          </p>
        )}
      </div>
      <p className="notification-feedback" role="status" aria-live="polite">
        {feedback}
      </p>
      {error && (
        <p className="notification-error" role="alert">
          {error}
        </p>
      )}
      {previews.length > 0 && (
        <div className="notification-preview-stack" aria-label="本页测试提醒">
          <div className="notification-preview-heading">
            <strong>提醒预览</strong>
            <span>
              {current.sound ? "声音偏好：开启（不播放）" : "声音偏好：关闭"}
            </span>
          </div>
          {previews.map((preview) => {
            const target = resolveNotificationTarget(preview, tasks);
            return (
              <article className="notification-preview" key={preview.taskId}>
                <Button
                  kind="icon"
                  className="notification-dismiss"
                  aria-label={`关闭测试提醒：${preview.title}`}
                  onClick={() =>
                    setPreviews((items) =>
                      items.filter((item) => item.taskId !== preview.taskId),
                    )
                  }
                >
                  <X size={16} />
                </Button>
                <button
                  className="notification-open"
                  disabled={target.state === "missing" || !onOpenTask}
                  onClick={() => {
                    const found = resolveNotificationTarget(
                      preview,
                      latest.current.tasks,
                    );
                    if (!found.task || !onOpenTask) return;
                    setPreviews((items) =>
                      items.filter((item) => item.taskId !== preview.taskId),
                    );
                    onOpenTask(found.task.id);
                  }}
                >
                  <span className="notification-preview-app">
                    <Bell size={15} />
                    Farfold · 测试提醒
                  </span>
                  <strong>{target.task?.title || preview.title}</strong>
                  <span>
                    {target.task?.agent || preview.agent} ·{" "}
                    {preview.reason || "测试示例，无实际待办"}
                  </span>
                  <small>
                    {target.state === "missing"
                      ? "对话已删除，无法打开"
                      : target.state === "changed"
                        ? "事项状态已变化，打开查看当前情况"
                        : "打开对应对话"}
                    <ArrowRight size={13} />
                  </small>
                </button>
              </article>
            );
          })}
          <p>卡片只显示在本页。关闭卡片不会处理或删除对话中的事项。</p>
        </div>
      )}
      <details className="sl-demo-tools">
        <summary>通知权限场景 · 演示</summary>
        <label className="notification-scenario">
          模拟系统当前权限
          <select
            aria-label="模拟系统当前通知权限"
            value={permission}
            onChange={(event) => changePermission(event.target.value)}
          >
            {Object.entries(NOTIFICATION_PERMISSION_LABELS).map(
              ([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ),
            )}
          </select>
        </label>
        <p>
          这里只切换原型状态。关闭或撤回模拟权限，会取消正在生成的预览并清除现有卡片。
        </p>
      </details>
      {dialog === "permission" && (
        <Modal
          title="通知权限 · 演示"
          onClose={closeDialog}
          footer={
            <>
              <Button onClick={() => changePermission("denied")}>
                暂不允许
              </Button>
              <Button primary onClick={() => changePermission("granted")}>
                允许（演示）
              </Button>
            </>
          }
        >
          <div className="notification-permission-intro">
            <Bell size={30} />
            <h3>允许 Farfold 在需要你时提醒吗？</h3>
          </div>
          <p>
            提醒可包含对话标题、Agent 和待处理事项；不会包含对话正文或密钥。
          </p>
          <p>
            这是权限交互演示，不是系统授权窗口。关闭本窗口会保留“尚未请求”，不会开启测试提醒。
          </p>
        </Modal>
      )}
      {dialog === "settings" && (
        <Modal
          title="检查系统通知权限"
          onClose={closeDialog}
          footer={
            <>
              <Button onClick={closeDialog}>稍后处理</Button>
              <Button primary disabled={checking} onClick={recheck}>
                <ArrowClockwise size={15} className={checking ? "spin" : ""} />
                {checking ? "正在检查…" : "返回并重新检查（演示）"}
              </Button>
            </>
          }
        >
          <p>
            正式应用在系统拒绝通知后，需要你手动允许；Farfold 不会自行打开权限。
          </p>
          <ol className="notification-permission-steps">
            <li>打开系统设置，找到“通知”。</li>
            <li>选择 Farfold，允许通知，并按需要选择横幅和声音。</li>
            <li>返回 Farfold 重新检查，再用测试提醒确认。</li>
          </ol>
          <p className="notification-boundary">
            原型不会打开系统设置，也不读取真实权限。这里演示返回后的界面变化。
          </p>
          <details className="sl-demo-tools">
            <summary>返回时的权限结果 · 演示</summary>
            <label className="notification-scenario">
              本次模拟检查结果
              <select
                aria-label="返回后的模拟通知权限"
                value={returnPermission}
                disabled={checking}
                onChange={(event) => setReturnPermission(event.target.value)}
              >
                <option value="granted">已允许</option>
                <option value="denied">仍未允许</option>
                <option value="unavailable">当前不可用</option>
              </select>
            </label>
          </details>
        </Modal>
      )}
    </section>
  );
}
