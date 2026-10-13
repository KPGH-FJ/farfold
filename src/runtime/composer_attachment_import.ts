import { invoke } from "@tauri-apps/api/core";
import {
  selectedAudioCandidate,
  audioInputFailure,
  audioNameCandidate,
} from "./audio_input";
import { fileBasename, filePathUri } from "./file_paths";
import { composerDrafts, type DraftAttachment } from "./drafts";
import { draftPersistence } from "./draft_storage";
import {
  IMAGE_INPUT_STRINGS,
  clipboardImageCandidate,
  imageInputError,
  selectedImageCandidate,
  validateDraftImage,
} from "./draft_images";

type Report = (message: string) => void;
function patch(
  key: string,
  generation: number,
  id: string,
  uri: string | undefined,
  update: Partial<DraftAttachment>,
) {
  if (
    composerDrafts.generation(key) !== generation ||
    !composerDrafts
      .read(key)
      .attachments.some(
        (attachment) => attachment.id === id && attachment.uri === uri,
      )
  )
    return false;
  composerDrafts.update(key, (draft) => ({
    ...draft,
    attachments: draft.attachments.map((attachment) =>
      attachment.id === id && attachment.uri === uri
        ? { ...attachment, ...update }
        : attachment,
    ),
  }));
  return true;
}
function present(key: string, generation: number, id: string, uri?: string) {
  return (
    composerDrafts.generation(key) === generation &&
    composerDrafts
      .read(key)
      .attachments.some(
        (attachment) => attachment.id === id && attachment.uri === uri,
      )
  );
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
        loading: true,
      },
    ];
  });
  if (!additions.length) return Promise.resolve();
  composerDrafts.update(key, (draft) => ({
    ...draft,
    attachments: [...draft.attachments, ...additions],
  }));
  const task = (async () => {
    for (const attachment of additions) {
      if (!present(key, generation, attachment.id, attachment.uri)) continue;
      try {
        let audio: string | null;
        try {
          audio = await selectedAudioCandidate(attachment.uri!);
        } catch (error) {
          if (
            patch(key, generation, attachment.id, attachment.uri, {
              loading: false,
              audioClassificationFailed: true,
            })
          )
            report(audioInputFailure(error));
          continue;
        }
        if (!present(key, generation, attachment.id, attachment.uri)) continue;
        if (audio || audioNameCandidate(attachment.name)) {
          patch(key, generation, attachment.id, attachment.uri, {
            kind: "file",
            mimeType: audio ?? "audio/unknown",
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
              /* Ordinary files retain their existing link fallback. */
            }
          }
          patch(key, generation, attachment.id, attachment.uri, {
            content,
            loading: false,
          });
          continue;
        }
        const candidate = await selectedImageCandidate(
          attachment.uri!,
          imageEnabled,
        );
        if (!present(key, generation, attachment.id, attachment.uri)) continue;
        if (!candidate) {
          patch(key, generation, attachment.id, attachment.uri, {
            loading: false,
          });
        } else if (!imageEnabled) {
          if (
            patch(key, generation, attachment.id, attachment.uri, {
              mimeType: candidate.mimeType,
              loading: false,
            })
          )
            report(IMAGE_INPUT_STRINGS.linkOnly);
        } else {
          if (
            !patch(key, generation, attachment.id, attachment.uri, {
              kind: "image",
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
          patch(key, generation, attachment.id, attachment.uri, {
            ...image,
            imageChecked: { ...image, uri: attachment.uri },
            loading: false,
          });
        }
      } catch (error) {
        if (
          patch(key, generation, attachment.id, attachment.uri, {
            loading: false,
            imageChecked: undefined,
          })
        )
          report(imageInputError(error));
      }
    }
  })();
  draftPersistence.trackAttachment(task);
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
  const task = (async () => {
    for (const [index, attachment] of additions.entries()) {
      if (!present(key, generation, attachment.id, attachment.uri)) continue;
      try {
        const candidate = await clipboardImageCandidate(files[index]!);
        if (
          !patch(key, generation, attachment.id, attachment.uri, {
            ...candidate,
            imageChecked: undefined,
          })
        )
          continue;
        const image = await validateDraftImage(
          candidate.data,
          candidate.mimeType,
        );
        patch(key, generation, attachment.id, attachment.uri, {
          ...image,
          imageChecked: { ...image },
          loading: false,
        });
      } catch (error) {
        if (
          patch(key, generation, attachment.id, attachment.uri, {
            loading: false,
            imageChecked: undefined,
          })
        )
          report(imageInputError(error));
      }
    }
  })();
  draftPersistence.trackAttachment(task);
  return task;
}
