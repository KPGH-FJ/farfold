import { useEffect, useRef, useState } from "react";
import { MessageAttachmentMedia } from "./MessageAttachmentMedia";
import { MESSAGE_ATTACHMENTS as S } from "../runtime/message_attachment_strings";
import {
  audioCompatibilityAvailable,
  prepareCompatibleAudio,
  type CompatibleAudio,
} from "../runtime/message_audio_compatibility";

/** The original failed preview is gone before this additional path is offered.
 * Both paths render the very same HTML audio controls and never autoplay. */
export function MessageAudioCompatibility({
  source,
  name,
}: {
  source: string;
  name: string;
}) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [audio, setAudio] = useState<CompatibleAudio | null>(null);
  const controls = useRef<HTMLDivElement>(null);
  const owner = useRef<{
    live: boolean;
    operation: AbortController | null;
    audio: CompatibleAudio | null;
  }>({ live: false, operation: null, audio: null });
  const retainControlFocus = () => {
    const group = controls.current;
    const active = group?.ownerDocument.activeElement;
    if (active && active !== group && group?.contains(active))
      group.focus({ preventScroll: true });
  };
  useEffect(() => {
    const current = owner.current;
    current.live = true;
    let retired = false;
    audioCompatibilityAvailable().then(
      (value) => {
        if (!retired) setAvailable(value);
      },
      () => {
        if (!retired) setAvailable(false);
      },
    );
    return () => {
      retired = true;
      current.live = false;
      current.operation?.abort();
      current.operation = null;
      current.audio?.dispose();
      current.audio = null;
    };
  }, [source]);
  const prepare = async () => {
    const current = owner.current;
    if (!current.live || current.operation || !available) return;
    const operation = new AbortController();
    current.operation = operation;
    retainControlFocus();
    setPending(true);
    setStatus(null);
    try {
      const value = await prepareCompatibleAudio(source, operation.signal);
      if (
        !current.live ||
        current.operation !== operation ||
        operation.signal.aborted
      ) {
        value?.dispose();
        return;
      }
      current.audio = value;
      if (value) retainControlFocus();
      setAudio(value);
    } catch (error) {
      if (
        current.live &&
        current.operation === operation &&
        !operation.signal.aborted
      )
        setStatus(
          error instanceof Error ? error.message : S.audioCompatibilityFailed,
        );
    } finally {
      if (current.live && current.operation === operation) {
        current.operation = null;
        retainControlFocus();
        setPending(false);
      }
    }
  };
  const cancel = () => {
    retainControlFocus();
    owner.current.operation?.abort();
    owner.current.operation = null;
    setPending(false);
    setStatus(S.audioCompatibilityCancelled);
  };
  return (
    <div
      ref={controls}
      tabIndex={-1}
      role="group"
      aria-label={S.audioCompatibility}
    >
      {audio ? (
        <>
          <p role="status">{S.audioCompatibilityReady}</p>
          <MessageAttachmentMedia
            media={{ kind: "audio", src: audio.src }}
            name={name}
            onFailure={() => {
              // MessageAttachmentMedia retires the source before this releases its lease.
              retainControlFocus();
              audio.dispose();
              owner.current.audio = null;
              setAudio(null);
              setStatus(S.audioCompatibilityFailed);
            }}
          />
        </>
      ) : available === false ? (
        <p role="status">{S.audioCompatibilityUnavailable}</p>
      ) : (
        available === true && (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() => void prepare()}
            >
              {S.audioCompatibility}
            </button>
            {pending && (
              <>
                <p role="status">{S.audioCompatibilityPreparing}</p>
                <button type="button" onClick={cancel}>
                  {S.audioCompatibilityCancel}
                </button>
              </>
            )}
          </>
        )
      )}
      {status && <p role="status">{status}</p>}
    </div>
  );
}
