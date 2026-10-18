import { invoke } from "@tauri-apps/api/core";
import { localResourcePath, type VerifiedFile } from "./file_delivery";
import { isAbsoluteFilePath } from "./file_paths";
import type { DraftAttachment } from "./drafts";

export const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
export const AUDIO_INPUT = {
  title: "加入音频内容",
  read: "加入音频内容",
  reread: "重新读取音频",
  approved: "已加入完整音频",
  filePosition: "文件位置，未加入音频内容",
  confirm: "加入完整音频",
  cancel: "取消",
  reading: "正在读取完整音频…",
  confirming: "正在核对音频…",
  scope:
    "将加入所选 WAV 文件的完整音频内容。不会录音、转写、转码或自动播放；由你发送后才交给 Agent。",
  formats:
    "支持经典 WAV 整数 PCM：单声道或双声道、8 位或 16 位、8–96 kHz；每条消息的完整音频文件合计最多 16 MiB，每段最多 10 分钟。",
  saved: "完整音频已加入并保存，可继续编辑。",
  awaitingSave: "完整音频已保留，正在等待保存。",
  saveFailed: "音频已保留，但尚未保存。请重试保存后再继续。",
  invalid: "音频结构不完整或内容无效，请重新选择文件。原附件已保留。",
  unsupported:
    "此音频格式暂不支持。请选择经典 WAV 整数 PCM 文件。原附件已保留。",
  limit:
    "这条消息的完整音频文件合计超过 16 MiB，请减少音频或选择较小的文件。原附件已保留。",
  durationLimit: "音频时长超过 10 分钟，请选择较短的文件。原附件已保留。",
  changed: "音频内容或位置已变化，请重新读取并确认。原内容已保留。",
  unreadable: "音频无法读取，请重新选择或移除附件。原内容已保留。",
  readPending: "音频读取尚未返回，请稍后重试。原内容已保留。",
  readBusy: "已有文件读取尚未结束，请稍后重试。原内容已保留。",
  sourceUnknown:
    "这段音频缺少已确认的本地来源。原音频已保留，请重新选择文件并确认完整内容。",
  approvalRequired: "请先确认加入完整音频，再发送这条消息。",
  recoveryRequired: "请先核对恢复的音频附件。原内容已保留。",
  capabilityUnknown:
    "尚未确认这个 Agent 是否支持音频输入。音频已保留，暂不能发送。",
  capabilityUnsupported:
    "这个 Agent 未提供音频输入。音频已保留，不能作为文件位置替代发送。",
  classificationFailed:
    "附件类型尚未检查完成，请重新选择或移除。原附件已保留。",
} as const;
export type AudioFailure = Exclude<
  keyof typeof AUDIO_INPUT,
  | "title"
  | "read"
  | "reread"
  | "approved"
  | "confirm"
  | "cancel"
  | "reading"
  | "confirming"
  | "scope"
  | "formats"
  | "saved"
  | "awaitingSave"
  | "filePosition"
>;
export class AudioInputError extends Error {
  constructor(readonly code: AudioFailure) {
    super(AUDIO_INPUT[code]);
  }
}
export function audioInputFailure(error: unknown): string {
  if (
    error instanceof Error &&
    (Object.values(AUDIO_INPUT) as string[]).includes(error.message)
  )
    return error.message;
  const code =
    error && typeof error === "object" && "code" in error ? error.code : null;
  const codes: readonly unknown[] = [
    "invalid",
    "unsupported",
    "limit",
    "durationLimit",
    "changed",
    "unreadable",
    "readPending",
    "readBusy",
  ];
  return AUDIO_INPUT[
    codes.includes(code) ? (code as AudioFailure) : "unreadable"
  ];
}
export interface LocalAudio {
  file: VerifiedFile;
  channels: 1 | 2;
  sampleRate: number;
  bitsPerSample: 8 | 16;
  frames: number;
  durationMs: number;
}
export interface AudioCapture extends LocalAudio {
  data: string;
  mimeType: "audio/wav";
}
function invalid(): never {
  throw new AudioInputError("invalid");
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((key) => !keys.includes(key))) invalid();
  return v;
}
function integer(v: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max) invalid();
  return v as number;
}
function string(v: unknown): string {
  if (
    typeof v !== "string" ||
    !v.length ||
    v.length > 32768 ||
    /[\u0000-\u001f\u007f]/.test(v)
  )
    invalid();
  return v;
}
export function parseLocalAudio(value: unknown): LocalAudio | null {
  if (value === null || value === undefined) return null;
  const v = record(value, [
    "file",
    "channels",
    "sampleRate",
    "bitsPerSample",
    "frames",
    "durationMs",
  ]);
  const f = record(v.file, [
    "root",
    "path",
    "resolvedPath",
    "name",
    "size",
    "sha256",
    "version",
  ]);
  const file = {
    root: string(f.root),
    path: string(f.path),
    resolvedPath: string(f.resolvedPath),
    name: string(f.name),
    size: integer(f.size, 44, MAX_AUDIO_BYTES),
    sha256: string(f.sha256),
    version: string(f.version),
  };
  if (
    ![file.root, file.path, file.resolvedPath].every(isAbsoluteFilePath) ||
    !/^[a-f0-9]{64}$/.test(file.sha256)
  )
    invalid();
  if (v.channels !== 1 && v.channels !== 2) invalid();
  if (v.bitsPerSample !== 8 && v.bitsPerSample !== 16) invalid();
  const sampleRate = integer(v.sampleRate, 8000, 96000);
  const frames = integer(v.frames, 1, sampleRate * 600);
  const durationMs = integer(v.durationMs, 1, 600000);
  if (
    durationMs !== Math.ceil((frames * 1000) / sampleRate) ||
    (frames * v.channels * v.bitsPerSample) / 8 > file.size - 44
  )
    invalid();
  return {
    file,
    channels: v.channels,
    sampleRate,
    bitsPerSample: v.bitsPerSample,
    frames,
    durationMs,
  };
}
export function audioCapability(handshake: unknown): boolean | undefined {
  const value = (
    handshake as {
      agentCapabilities?: { promptCapabilities?: { audio?: unknown } };
    } | null
  )?.agentCapabilities?.promptCapabilities?.audio;
  return typeof value === "boolean" ? value : undefined;
}
export function audioCapabilityNotice(
  capability: boolean | undefined,
): string | null {
  return capability === true
    ? null
    : capability === false
      ? AUDIO_INPUT.capabilityUnsupported
      : AUDIO_INPUT.capabilityUnknown;
}
export function audioNameCandidate(name: string, mimeType?: string): boolean {
  return (
    !!mimeType?.toLowerCase().startsWith("audio/") ||
    /\.(wav|wave|mp3|mp2|flac|ogg|oga|opus|aac|m4a|aiff|aif|aifc|wma|amr|mid|midi|mka|weba)$/i.test(
      name,
    )
  );
}
export async function selectedAudioCandidate(
  uri: string,
): Promise<string | null> {
  try {
    const raw = await invoke<unknown>("draft_attachment_audio_candidate", {
      uri,
    });
    if (raw === null) return null;
    const v = record(raw, ["mimeType"]);
    if (
      typeof v.mimeType !== "string" ||
      !/^audio\/[a-z0-9.+-]+$/.test(v.mimeType)
    )
      invalid();
    return v.mimeType;
  } catch {
    throw new AudioInputError("classificationFailed");
  }
}
export async function readAudioInput(
  uri: string,
  expected: VerifiedFile | null = null,
): Promise<AudioCapture> {
  if (!localResourcePath(uri)) throw new AudioInputError("sourceUnknown");
  let raw: unknown;
  try {
    raw = await invoke("draft_attachment_audio", { uri, expected });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error ? error.code : null;
    const codes: readonly unknown[] = [
      "invalid",
      "unsupported",
      "limit",
      "durationLimit",
      "changed",
      "unreadable",
      "readPending",
      "readBusy",
    ];
    throw new AudioInputError(
      codes.includes(code) ? (code as AudioFailure) : "unreadable",
    );
  }
  const v = record(raw, [
    "file",
    "data",
    "mimeType",
    "channels",
    "sampleRate",
    "bitsPerSample",
    "frames",
    "durationMs",
  ]);
  const { data, mimeType, ...metadata } = v;
  const local = parseLocalAudio(metadata)!;
  if (
    mimeType !== "audio/wav" ||
    typeof data !== "string" ||
    !data.length ||
    data.length > 4 * Math.ceil(MAX_AUDIO_BYTES / 3) ||
    data.length % 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
  )
    invalid();
  let decoded: string;
  try {
    decoded = atob(data);
  } catch {
    invalid();
  }
  if (
    decoded.length !== local.file.size ||
    btoa(decoded) !== data ||
    localResourcePath(uri) !== local.file.path
  )
    invalid();
  if (
    expected &&
    (
      [
        "root",
        "path",
        "resolvedPath",
        "name",
        "size",
        "sha256",
        "version",
      ] as const
    ).some((key) => local.file[key] !== expected[key])
  )
    throw new AudioInputError("changed");
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) {
    bytes[index] = decoded.charCodeAt(index);
  }
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (hash !== local.file.sha256) invalid();
  return { ...local, data, mimeType };
}
export function localAudio(capture: AudioCapture): LocalAudio {
  const { data: _data, mimeType: _mime, ...local } = capture;
  return structuredClone(local);
}
export async function verifyAudioInput(
  attachment: Pick<DraftAttachment, "uri" | "data" | "mimeType" | "localAudio">,
): Promise<AudioCapture> {
  const local = parseLocalAudio(attachment.localAudio);
  if (
    !local ||
    !attachment.uri ||
    localResourcePath(attachment.uri) !== local.file.path
  )
    throw new AudioInputError("sourceUnknown");
  const capture = await readAudioInput(attachment.uri, local.file);
  if (
    capture.data !== attachment.data ||
    capture.mimeType !== attachment.mimeType ||
    JSON.stringify(localAudio(capture)) !== JSON.stringify(local)
  )
    throw new AudioInputError("changed");
  return capture;
}

/** Historical payload/URI alone is never permission for a new local read. */
export function hasAudioReviewSource(attachment: DraftAttachment): boolean {
  if (attachment.kind !== "audio") return !!attachment.uri;
  try {
    const local = parseLocalAudio(attachment.localAudio);
    return (
      !!local &&
      !!attachment.uri &&
      localResourcePath(attachment.uri) === local.file.path
    );
  } catch {
    return false;
  }
}

/** Count complete WAV files, including repeated blocks and metadata. */
export function addAudioBytes(total: number, bytes: number): number {
  const sum = total + bytes;
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    !Number.isSafeInteger(sum) ||
    sum > MAX_AUDIO_BYTES
  )
    throw new AudioInputError("limit");
  return sum;
}
