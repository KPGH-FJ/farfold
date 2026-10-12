import type { Attachment, PromptBlock } from "./session_types";
import type { DraftAttachment } from "./drafts";
import { resourceDraftAttachment } from "./prompt_blocks";

/**
 * W3-6 用户消息操作：把一条已发送的用户消息还原为输入块或草稿附件。
 * 只重排这条消息已有的内容；不复制、不重建 Agent 侧数据，未知附件
 * 一律退回为文件链接而不是丢弃。
 */
export function userMessageBlocks(
  text: string,
  attachments: readonly Attachment[],
): PromptBlock[] {
  const blocks: PromptBlock[] = [];
  if (text.trim()) blocks.push({ type: "text", text: text.trim() });
  for (const item of attachments) {
    if (item.kind === "image" && item.data)
      blocks.push({
        type: "image",
        data: item.data,
        mimeType: item.mimeType ?? "image/png",
        ...(item.uri ? { uri: item.uri } : {}),
      });
    else if (item.uri && item.text != null)
      blocks.push({
        type: "resource",
        resource: {
          uri: item.uri,
          mimeType: item.mimeType ?? "text/plain",
          text: item.text,
        },
        ...(item.localDocumentText !== undefined
          ? { localDocumentText: structuredClone(item.localDocumentText) }
          : {}),
      });
    else if (item.uri)
      blocks.push({
        type: "resource_link",
        name: item.name,
        uri: item.uri,
        ...(item.mimeType ? { mimeType: item.mimeType } : {}),
      });
  }
  return blocks;
}

/** 同一消息还原为草稿附件（编辑后重发/从这里开新对话）。 */
export function userMessageDraftAttachments(
  attachments: readonly Attachment[],
): DraftAttachment[] {
  const out: DraftAttachment[] = [];
  for (const item of attachments) {
    if (item.kind === "image" && item.data)
      out.push({
        id: crypto.randomUUID(),
        kind: "image",
        name: item.name,
        uri: item.uri,
        data: item.data,
        mimeType: item.mimeType,
      });
    else if (item.uri) {
      const [block] = userMessageBlocks("", [item]);
      if (block?.type === "resource" || block?.type === "resource_link")
        out.push(
          resourceDraftAttachment(block, {
            name: item.name,
            keepContent: true,
          }),
        );
    }
  }
  return out;
}
