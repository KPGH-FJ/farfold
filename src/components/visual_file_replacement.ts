import type { VisualPreview } from "../runtime/file_delivery";
import type { VisualFeedbackLocation } from "../runtime/visual_feedback";
import { VISUAL_PREVIEW_STRINGS as S } from "../runtime/visual_preview";

type Slot = 0 | 1;
type PdfSurface = { slot: Slot; canvas: { current: HTMLCanvasElement | null } };
type ImageSurface = { slot: Slot; image: { current: HTMLImageElement | null } };
type DrawnPdfPage = {
  element: HTMLCanvasElement;
  page: number;
  pageCount: number;
};
type LoadedImage = { element: HTMLImageElement; url: string };
type Request = {
  preview: VisualPreview;
  controller: AbortController;
  current: () => boolean;
};
type Candidate<Surface, Receipt> = Request & {
  surface: Surface;
  settle: (result: Receipt | Error) => void;
};
type Ready<Surface, Receipt> = Receipt & {
  preview: VisualPreview;
  surface: Surface;
};

export type DrawnPdfPreview = Ready<PdfSurface, DrawnPdfPage>;
export type PdfPreviewCandidate = Candidate<PdfSurface, DrawnPdfPage> & {
  page: number;
};
export type LoadedImagePreview = Ready<ImageSurface, LoadedImage>;
export type ImagePreviewCandidate = Candidate<ImageSurface, LoadedImage>;

function waitForSurface<
  Receipt extends object,
  T extends Request & { surface: unknown },
>(
  request: T,
  stage: (candidate: T & { settle: (result: Receipt | Error) => void }) => void,
): Promise<Ready<T["surface"], Receipt>> {
  const signal = request.controller.signal;
  return new Promise((resolve, reject) => {
    const cancel = () => settle(new Error(S.cancelled));
    const settle = (result: Receipt | Error) => {
      signal.removeEventListener("abort", cancel);
      if (result instanceof Error) reject(result);
      else
        resolve({
          ...result,
          preview: request.preview,
          surface: request.surface,
        });
    };
    if (signal.aborted) return cancel();
    signal.addEventListener("abort", cancel, { once: true });
    stage({ ...request, settle });
  });
}

/** The visible snapshot stays in place until its mounted candidate has pixels. */
export async function stageVisualReplacement(
  request: Request,
  location: VisualFeedbackLocation,
  displayedSlot: Slot | undefined,
  stage: (candidate: {
    pdfCandidate?: PdfPreviewCandidate;
    imageCandidate?: ImagePreviewCandidate;
  }) => void,
): Promise<{ drawnPdf?: DrawnPdfPreview; loadedImage?: LoadedImagePreview }> {
  const slot = displayedSlot === 1 ? 0 : 1;
  const pdf = request.preview.mimeType === "application/pdf";
  if (pdf !== (location.kind === "pdf")) throw new Error(S.failed);
  if (location.kind === "pdf") {
    const surface: PdfSurface = { slot, canvas: { current: null } };
    const drawnPdf = await waitForSurface(
      { ...request, page: location.page, surface },
      (pdfCandidate: PdfPreviewCandidate) => stage({ pdfCandidate }),
    );
    return { drawnPdf };
  }
  const surface: ImageSurface = { slot, image: { current: null } };
  const loadedImage = await waitForSurface(
    { ...request, surface },
    (imageCandidate: ImagePreviewCandidate) => stage({ imageCandidate }),
  );
  return { loadedImage };
}
