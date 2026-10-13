import { AUDIO_INPUT, type LocalAudio } from "../runtime/audio_input";

export function AudioInputDetails({ audio }: { audio: LocalAudio | null }) {
  if (!audio) return <p>{AUDIO_INPUT.sourceUnknown}</p>;
  return (
    <dl className="audio-input-details">
      <dt>文件</dt>
      <dd>{audio.file.name}</dd>
      <dt>完整文件</dt>
      <dd>{audio.file.size.toLocaleString()} 字节</dd>
      <dt>时长</dt>
      <dd>
        {(audio.durationMs / 1000).toLocaleString(undefined, {
          maximumFractionDigits: 3,
        })}{" "}
        秒
      </dd>
      <dt>声道</dt>
      <dd>{audio.channels === 1 ? "单声道" : "双声道"}</dd>
      <dt>采样率</dt>
      <dd>{audio.sampleRate.toLocaleString()} Hz</dd>
      <dt>位深</dt>
      <dd>{audio.bitsPerSample} 位整数 PCM</dd>
    </dl>
  );
}
