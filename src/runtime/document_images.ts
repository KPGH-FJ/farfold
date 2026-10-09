import type { DocxImage } from "./docx_types";

/** One resource pool per displayed document; only visible consumers retain URLs. */
export class DocumentImages {
  private readonly images: Map<string, DocxImage>;
  private readonly urls = new Map<
    string,
    { url: string; references: number }
  >();

  constructor(images: DocxImage[]) {
    this.images = new Map(images.map((image) => [image.id, image]));
  }

  get(id: string): DocxImage | undefined {
    return this.images.get(id);
  }

  acquire(id: string): { url: string; release: () => void } | null {
    const image = this.images.get(id);
    if (!image) return null;
    let resource = this.urls.get(id);
    if (!resource) {
      resource = {
        url: URL.createObjectURL(
          new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }),
        ),
        references: 0,
      };
      this.urls.set(id, resource);
    }
    resource.references += 1;
    const held = resource;
    let released = false;
    return {
      url: held.url,
      release: () => {
        if (released) return;
        released = true;
        held.references -= 1;
        if (held.references === 0) {
          URL.revokeObjectURL(held.url);
          this.urls.delete(id);
        }
      },
    };
  }
}
