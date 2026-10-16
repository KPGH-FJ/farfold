export const MESSAGE_ATTACHMENTS = {
  label: "消息附件",
  kindNames: { image: "图片", audio: "音频" },
  audioUnavailable: "音频暂时无法播放",
  imageFailed: "这张图片无法显示，消息原文和来源仍已保留。",
  audioFailed: "这段音频无法播放，消息原文和来源仍已保留。",
  retryMedia: "重新载入",
  previewUnavailable: "此附件暂不支持预览",
  mediaTooLarge: "此媒体超过 16 MiB，本次未加载；消息原文和来源仍已保留。",
  mediaInvalid: "媒体数据格式无法读取，消息原文和来源仍已保留。",
  historyImage: "历史图片",
  historyImageChecking: "正在检查图片…",
  historyImageUnavailable: "此图片暂时无法预览，消息原文仍已保留。",
} as const;
