import { invoke } from "@tauri-apps/api/core";
import {
  selectedAudioCandidate,
  audioInputFailure,
  audioNameCandidate,
} from "./audio_input";
import { fileBasename, filePathUri } from "./file_paths";
import { composerDrafts, type DraftAttachment } from "./drafts";
import { draftPersistence } from "./draft_storage";
import { IMAGE_BYTES_STRINGS } from "./image_bytes";
import {
  IMAGE_INPUT_STRINGS,
  clipboardImageCandidate,
  imageInputError,
  selectedImageCandidate,
  validateDraftImage,
} from "./draft_images";

type Report = (message: string, failedImageId?: string) => void;

/** Saving waits only for unfinished input that still belongs to this draft.
 * Withdrawing input does not cancel its underlying read. The actual task still
 * settles separately, and retired members can never regain write ownership. */
function attachmentWork(
  key: string,
  generation: number,
  additions: readonly DraftAttachment[],
) {
  const pending = new Map(additions.map((item) => [item.id, item]));
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let settled = false;
  let unsubscribe = () => {};
  function finish() {
    if (settled) return;
    settled = true;
    pending.clear();
    unsubscribe();
    release();
  }
  function refresh() {
    const live = new Set(composerDrafts.read(key).attachments);
    for (const [id, expected] of pending)
      if (composerDrafts.generation(key) !== generation || !live.has(expected))
        pending.delete(id);
    if (!pending.size) finish();
  }
  unsubscribe = composerDrafts.subscribe(refresh);
  refresh();
  return {
    present(attachment: DraftAttachment) {
      refresh();
      return pending.has(attachment.id);
    },
    patch(attachment: DraftAttachment, update: Partial<DraftAttachment>) {
      refresh();
      const expected = pending.get(attachment.id);
      if (!expected) return false;
      const next = { ...expected, ...update };
      // Publish our replacement as the expected member before notifying the
      // draft subscribers. Ordinary text edits retain this exact attachment.
      pending.set(attachment.id, next);
      composerDrafts.update(key, (draft) => ({
        ...draft,
        attachments: draft.attachments.map((item) =>
          item === expected ? next : item,
        ),
      }));
      return true;
    },
    done(attachment: DraftAttachment) {
      pending.delete(attachment.id);
      refresh();
    },
    track(task: Promise<void>) {
      // Consume both outcomes without pretending that a released save wait
      // means the File/native operation itself has stopped.
      void task.then(finish, finish);
      draftPersistence.trackAttachment(waiting);
    },
  };
}

/** Keep the exact chosen attachments before reading them. Every late result
 * remains with its original draft and is discarded if that input was cleared. */
export async function addPickedAttachments(
  key: string,
  paths: readonly string[],
  imageEnabled: boolean,
  report: Report,
  project?: { cwd: string; path: string; embed: boolean },
): Promise<void> {
  const generation = composerDrafts.generation(key);
  const existing = new Set(
    composerDrafts.read(key).attachments.map((item) => item.uri),
  );
  const additions: DraftAttachment[] = paths.flatMap((path) => {
    const uri = filePathUri(path);
    if (existing.has(uri)) return [];
    existing.add(uri);
    return [
      {
        id: crypto.randomUUID(),
        kind: "file",
        name: fileBasename(path),
        uri,
        deliveryMode: project ? "text" : "location",
        loading: true,
      },
    ];
  });
  if (!additions.length) return Promise.resolve();
  composerDrafts.update(key, (draft) => ({
    ...draft,
    attachments: [...draft.attachments, ...additions],
  }));
  const work = attachmentWork(key, generation, additions);
  const task = (async () => {
    for (const attachment of additions) {
      if (!work.present(attachment)) continue;
      try {
        let audio: string | null;
        try {
          audio = await selectedAudioCandidate(attachment.uri!);
        } catch (error) {
          if (
            work.patch(attachment, {
              loading: false,
              audioClassificationFailed: true,
            })
          )
            report(audioInputFailure(error));
          continue;
        }
        if (!work.present(attachment)) continue;
        if (audio || audioNameCandidate(attachment.name)) {
          work.patch(attachment, {
            kind: "file",
            mimeType: audio ?? "audio/unknown",
            deliveryMode: "location",
            loading: false,
          });
          continue;
        }
        if (project) {
          let content: string | undefined;
          if (project.embed) {
            try {
              content = await invoke<string>("project_file_read", {
                cwd: project.cwd,
                path: project.path,
              });
            } catch {
              // Preserve the explicit text choice. Sending rechecks this
              // source and never turns a failed text read into a file link.
            }
          }
          work.patch(attachment, {
            content,
            loading: false,
          });
          continue;
        }
        const candidate = await selectedImageCandidate(
          attachment.uri!,
          imageEnabled,
        );
        if (!work.present(attachment)) continue;
        if (!candidate) {
          work.patch(attachment, {
            loading: false,
          });
        } else if (!imageEnabled) {
          if (
            work.patch(attachment, {
              mimeType: candidate.mimeType,
              loading: false,
            })
          )
            report(IMAGE_INPUT_STRINGS.linkOnly);
        } else {
          if (
            !work.patch(attachment, {
              kind: "image",
              deliveryMode: undefined,
              mimeType: candidate.mimeType,
              data: candidate.data ?? undefined,
              imageChecked: undefined,
            })
          )
            continue;
          const image = await validateDraftImage(
            candidate.data ?? "",
            candidate.mimeType,
          );
          work.patch(attachment, {
            ...image,
            imageChecked: { ...image, uri: attachment.uri },
            loading: false,
          });
        }
      } catch (error) {
        const message = imageInputError(error);
        // These two native read failures occur only after identifying a bitmap.
        const knownImage =
          imageEnabled &&
          (message === IMAGE_BYTES_STRINGS.tooLarge ||
            message === IMAGE_INPUT_STRINGS.changed);
        if (
          work.patch(attachment, {
            ...(knownImage ? { kind: "image", deliveryMode: undefined } : {}),
            loading: false,
            imageChecked: undefined,
          })
        )
          report(message, attachment.id);
      } finally {
        work.done(attachment);
      }
    }
  })();
  work.track(task);
  return task;
}

export function addClipboardImages(
  key: string,
  files: readonly File[],
  report: Report,
): Promise<void> {
  const generation = composerDrafts.generation(key);
  const additions: DraftAttachment[] = files.map((file) => ({
    id: crypto.randomUUID(),
    kind: "image",
    name: file.name || "pasted.png",
    loading: true,
  }));
  composerDrafts.update(key, (draft) => ({
    ...draft,
    attachments: [...draft.attachments, ...additions],
  }));
  const work = attachmentWork(key, generation, additions);
  const task = (async () => {
    for (const [index, attachment] of additions.entries()) {
      if (!work.present(attachment)) continue;
      try {
        const candidate = await clipboardImageCandidate(files[index]!);
        if (
          !work.patch(attachment, {
            ...candidate,
            imageChecked: undefined,
          })
        )
          continue;
        const image = await validateDraftImage(
          candidate.data,
          candidate.mimeType,
        );
        work.patch(attachment, {
          ...image,
          imageChecked: { ...image },
          loading: false,
        });
      } catch (error) {
        if (
          work.patch(attachment, {
            loading: false,
            imageChecked: undefined,
          })
        )
          report(imageInputError(error), attachment.id);
      } finally {
        work.done(attachment);
      }
    }
  })();
  work.track(task);
  return task;
}
