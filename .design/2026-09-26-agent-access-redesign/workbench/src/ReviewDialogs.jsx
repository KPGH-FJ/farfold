import React from "react";
import { Download } from "@phosphor-icons/react";
import { Modal, Button } from "./ui";
export default function ReviewDialogs({
  modal,
  setModal,
  feedback,
  feedbackText,
  setFeedbackText,
  rating,
  setRating,
  exportFeedback,
  saveFeedback,
}) {
  return (
    <>
      {" "}
      {modal === "feedback" && (
        <Modal
          title="原型反馈"
          onClose={() => setModal(null)}
          footer={
            <>
              <Button onClick={exportFeedback}>
                <Download size={14} />
                导出 {feedback.length} 条反馈
              </Button>
              <Button
                primary
                disabled={!feedbackText.trim()}
                onClick={saveFeedback}
              >
                保存意见
              </Button>
            </>
          }
        >
          <div className="v2-rating">
            {["认可方向", "需要调整", "不符合预期"].map((r) => (
              <button
                key={r}
                className={rating === r ? "selected" : ""}
                onClick={() => setRating(r)}
              >
                {r}
              </button>
            ))}
          </div>
          <label className="field">
            <span>具体意见</span>
            <textarea
              rows={5}
              value={feedbackText}
              onChange={(e) => setFeedbackText(e.target.value)}
              placeholder="可以说说刚才哪一步、哪个页面…"
            />
          </label>
          <p className="v2-help">只保存在本浏览器，不会自动发送。</p>
        </Modal>
      )}
      {modal === "review" && (
        <Modal title="原型说明" wide onClose={() => setModal(null)}>
          <div className="v2-review-notes">
            <h3>从原任务出发，准备后回到原任务</h3>
            <p>
              沿用现有 Farfold 的新对话、侧栏和三栏工作台。准备、程序管理及 API
              设置围绕同一份草稿衔接，保留正文、资料与工作位置；完成后不自动发送。
            </p>
            <h3>接入管理与服务管理各有完整职责</h3>
            <p>
              区分程序、账号与服务、模型，保留多份程序及移除管理。API
              独立管理多个模型，保存与选用分开，登录是缺条件时的动作。
            </p>
            <h3>其他工作继续进行</h3>
            <p>
              每段对话独立运行；待回应、待发、停止与结果未知保持在原对话。更改新选择不会改动旧对话，历史和服务变更分别处理。
            </p>
            <h3>这份原型能证明什么</h3>
            <p>
              可评审页面、业务关系与模拟失败出口。全部
              Agent、账号、安装、模型响应及历史内容均为演示；不读取正式配置或密钥，不执行真实请求。LifeModel
              未实现能力保持说明状态。
            </p>
            <p>
              首次打开可以先写草稿，再选择
              Agent；发送前选择工作文件夹。需要查看对话和工作台时，可用“载入示例”替换当前演示，再从侧栏进入。草稿、文件意见与归档设置保存在本浏览器；“重启演示”恢复已有工作，“重置演示”清空模拟工作并回到首次打开。
            </p>
          </div>
        </Modal>
      )}
    </>
  );
}
