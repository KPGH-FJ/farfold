import { invoke } from "@tauri-apps/api/core";

export const MIN_ARTIFACT_WIDTH = 320;
export const MAX_ARTIFACT_WIDTH = 720;
const DEFAULT_ARTIFACT_WIDTH = 510;
const key = "artifactPaneWidth";

export function clampArtifactWidth(width: number): number {
  return Math.min(MAX_ARTIFACT_WIDTH, Math.max(MIN_ARTIFACT_WIDTH, width));
}

type WidthState = {
  width: number;
  ready: boolean;
  error: "load" | "save" | null;
};

export class ArtifactPaneWidthPreference {
  private state: WidthState = {
    width: DEFAULT_ARTIFACT_WIDTH,
    ready: false,
    error: null,
  };
  private savedWidth = DEFAULT_ARTIFACT_WIDTH;
  private reading: Promise<void> | null = null;
  private writing = false;
  private listeners = new Set<() => void>();

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(patch: Partial<WidthState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  load = (): Promise<void> => {
    if (this.state.ready) return Promise.resolve();
    if (this.reading) return this.reading;
    this.update({ error: null });
    this.reading = Promise.resolve()
      .then(() => invoke<unknown>("settings_get", { key }))
      .then((value) => {
        this.savedWidth =
          typeof value === "number" && Number.isFinite(value)
            ? clampArtifactWidth(value)
            : DEFAULT_ARTIFACT_WIDTH;
        this.update({ width: this.savedWidth, ready: true });
      })
      .catch(() => this.update({ error: "load" }))
      .finally(() => {
        this.reading = null;
      });
    return this.reading;
  };

  resize(next: number) {
    if (!this.state.ready || !Number.isFinite(next)) return;
    const width = clampArtifactWidth(next);
    if (width === this.state.width) return;
    this.update({ width, error: null });
    if (!this.writing) void this.persist();
  }

  private async persist() {
    this.writing = true;
    try {
      // Key repeats and successive drags may change the desired width during
      // a save. Finish in order and keep only the latest pending value.
      while (this.savedWidth !== this.state.width) {
        const value = this.state.width;
        await invoke("settings_set", { key, value });
        this.savedWidth = value;
      }
    } catch {
      this.update({ width: this.savedWidth, error: "save" });
    } finally {
      this.writing = false;
    }
  }
}

// The content pane can be mounted in more than one conversation, while its
// normal width is a single desktop preference.
export const artifactPaneWidth = new ArtifactPaneWidthPreference();
