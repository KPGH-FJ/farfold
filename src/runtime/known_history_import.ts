import {
  closeHistoryPreview,
  commitHistoryPreview,
  hasPreviewContent,
  previewHistory,
  type HistoryPreview,
  type HistoryPreviewInterest,
  type HistoryPreviewTarget,
} from "./history_import";
import { IMPORT_STRINGS as S } from "./import_strings";
import type { IndexRow } from "./sessions";

interface Actions {
  load: typeof previewHistory;
  close: typeof closeHistoryPreview;
  commit: typeof commitHistoryPreview;
}
export interface KnownHistoryState {
  preview: HistoryPreview | null;
  saved: IndexRow | null;
  error: string | null;
}

/** A typed target is only a request, never a discovered or saved conversation. */
export class KnownHistoryReader {
  state: KnownHistoryState = { preview: null, saved: null, error: null };
  private owned: HistoryPreview | null = null;
  private owner: (HistoryPreviewInterest & { retire: () => void }) | null =
    null;
  private activeJob = false;
  private committed = false;
  private generation = 0;
  lastSaved: IndexRow | null = null;

  constructor(
    private readonly changed: () => void,
    private readonly actions: Actions = {
      load: previewHistory,
      close: closeHistoryPreview,
      commit: commitHistoryPreview,
    },
  ) {}

  private publish(state: KnownHistoryState) {
    this.state = state;
    this.changed();
  }

  get preview(): HistoryPreview | null {
    return this.owner?.inquiryCurrent?.() ? this.state.preview : null;
  }

  retire() {
    this.generation++;
    this.owner?.retire();
    if (this.state.preview) this.publish({ ...this.state, preview: null });
  }

  reset() {
    this.retire();
    this.publish({ preview: null, saved: null, error: null });
  }

  async release(): Promise<void> {
    // Internal close ends the read but keeps this action's result identity.
    // External retirement (target/auth/view change) advances generation.
    this.owner?.retire();
    if (this.state.preview) this.publish({ ...this.state, preview: null });
    const owned = this.owned;
    if (!owned) return;
    try {
      await this.actions.close(owned);
    } catch {
      // Keep the exact cleanup receipt; subsequent work must retry its close.
      throw new Error(S.cleanupFailed);
    }
    if (this.owned === owned) this.owned = null;
  }

  async read(
    agentId: string,
    target: HistoryPreviewTarget,
    current: () => boolean,
    onAuthenticationRequired?: () => void,
  ): Promise<void> {
    if (this.activeJob || !current()) return;
    if (!target.nativeSessionId.trim() || !target.cwd) {
      this.publish({ preview: null, saved: null, error: S.knownInvalid });
      return;
    }
    this.activeJob = true;
    let owner: typeof this.owner = null;
    try {
      await this.release();
      if (!current()) return;
      const abort = new AbortController();
      let interested = true;
      owner = {
        inquirySignal: abort.signal,
        inquiryCurrent: () => {
          // Once retired, a later matching view cannot resurrect this read.
          interested = interested && !abort.signal.aborted && current();
          return interested;
        },
        retire: () => {
          interested = false;
          abort.abort();
        },
      };
      this.owner = owner;
      this.generation++;
      this.committed = false;
      this.publish({ preview: null, saved: null, error: null });
      const loaded = await this.actions.load(agentId, target, owner);
      this.owned = loaded;
      if (!owner.inquiryCurrent?.()) {
        await this.release();
        return;
      }
      if (
        loaded.agentId !== agentId ||
        loaded.nativeSessionId !== target.nativeSessionId ||
        loaded.purpose !== "importPreview" ||
        !loaded.replayComplete
      )
        throw new Error(S.loadFailed);
      if (!hasPreviewContent(loaded)) throw new Error(S.noContent);
      this.publish({ preview: loaded, saved: null, error: null });
    } catch (reason) {
      if (owner?.inquiryCurrent?.() ?? current()) {
        const message = String(reason).replace(/^Error:\s*/, "");
        const authenticationRequired = message === "AUTH_REQUIRED";
        this.publish({
          preview: null,
          saved: null,
          error: authenticationRequired
            ? S.authRequired
            : message === S.noContent
              ? S.noContent
              : message === S.cleanupFailed
                ? S.cleanupFailed
                : S.loadFailed,
        });
        if (authenticationRequired) onAuthenticationRequired?.();
      }
    } finally {
      this.activeJob = false;
    }
  }

  async add(refresh: () => Promise<void>): Promise<void> {
    const preview = this.preview;
    if (
      this.activeJob ||
      this.committed ||
      !preview ||
      !hasPreviewContent(preview)
    )
      return;
    this.activeJob = true;
    const owner = this.owner;
    const generation = this.generation;
    const current = () =>
      generation === this.generation && owner?.inquiryCurrent?.() === true;
    let publishResult = false;
    try {
      const saved = await this.actions.commit(preview, null);
      this.committed = true;
      this.lastSaved = saved;
      // A dispatched index write has a real outcome even after the view closes.
      // Its receipt must not become the outcome of a new target or dialog.
      publishResult = current();
      if (publishResult) this.publish({ preview: null, saved, error: null });
      await this.release();
      try {
        await refresh();
      } catch {
        if (publishResult && generation === this.generation)
          this.publish({ ...this.state, error: S.refreshFailed });
      }
    } catch (reason) {
      if (current() || (publishResult && generation === this.generation))
        this.publish({
          ...this.state,
          error:
            reason instanceof Error && reason.message === S.cleanupFailed
              ? S.cleanupFailed
              : S.addFailed,
        });
    } finally {
      this.activeJob = false;
    }
  }
}
