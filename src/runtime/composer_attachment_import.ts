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
  update: Partial<DraftAttachment>,
) {
  if (
    composerDrafts.generation(key) !== generation ||
    !composerDrafts
      .read(key)
      .attachments.some((attachment) => attachment.id === id)
  )
    return false;
  composerDrafts.update(key, (draft) => ({
    ...draft,
    attachments: draft.attachments.map((attachment) =>
      attachment.id === id ? { ...attachment, ...update } : attachment,
    ),
  }));
  return true;
}
function present(key: string, generation: number, id: string) {
  return (
    composerDrafts.generation(key) === generation &&
    composerDrafts
      .read(key)
      .attachments.some((attachment) => attachment.id === id)
  );
}

/** Keep the exact chosen attachments before reading them. Every late result
 * remains with its original draft and is discarded if that input was cleared. */
export function addPickedAttachments(
  key: string,
  paths: readonly string[],
  imageEnabled: boolean,
  report: Report,
): Promise<void> {
  const generation = composerDrafts.generation(key);
  const additions: DraftAttachment[] = paths.map((path) => ({
    id: crypto.randomUUID(),
    kind: "file",
    name: fileBasename(path),
    uri: filePathUri(path),
    loading: true,
  }));
  composerDrafts.update(key, (draft) => ({
    ...draft,
    attachments: [...draft.attachments, ...additions],
  }));
  const task = (async () => {
    for (const attachment of additions) {
      if (!present(key, generation, attachment.id)) continue;
      try {
        const candidate = await selectedImageCandidate(
          attachment.uri!,
          imageEnabled,
        );
        if (!present(key, generation, attachment.id)) continue;
        if (!candidate) {
          patch(key, generation, attachment.id, { loading: false });
        } else if (!imageEnabled) {
          if (
            patch(key, generation, attachment.id, {
              mimeType: candidate.mimeType,
              loading: false,
            })
          )
            report(IMAGE_INPUT_STRINGS.linkOnly);
        } else {
          if (
            !patch(key, generation, attachment.id, {
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
          patch(key, generation, attachment.id, {
            ...image,
            imageChecked: { ...image, uri: attachment.uri },
            loading: false,
          });
        }
      } catch (error) {
        if (
          patch(key, generation, attachment.id, {
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
      if (!present(key, generation, attachment.id)) continue;
      try {
        const candidate = await clipboardImageCandidate(files[index]!);
        if (
          !patch(key, generation, attachment.id, {
            ...candidate,
            imageChecked: undefined,
          })
        )
          continue;
        const image = await validateDraftImage(
          candidate.data,
          candidate.mimeType,
        );
        patch(key, generation, attachment.id, {
          ...image,
          imageChecked: { ...image },
          loading: false,
        });
      } catch (error) {
        if (
          patch(key, generation, attachment.id, {
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
