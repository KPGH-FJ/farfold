export interface BrowserSurfaceSnapshot {
  readonly busy: boolean;
  readonly failed: boolean;
  readonly blocked: boolean;
}

export interface BrowserSurfaceHold {
  /** Re-read after a guard subscription notification. False after release. */
  readonly ready: boolean;
  release(): void;
}

export interface BrowserSurfaceRegistration {
  release(): void;
  /** Reserve the native footprint before showing; false while a transition holds it. */
  reveal(): boolean;
  requestClose(): void;
}

interface Surface {
  close: () => Promise<void>;
  hide?: () => Promise<void>;
  hidden: boolean;
  closeRequested: boolean;
  failed: boolean;
}

interface Hold {
  active: boolean;
  ready: boolean;
}

/**
 * Coordinates UI transitions with actual native hide/close acknowledgements.
 * It does not own native pages, permissions, or navigation history.
 * Register before starting an open; callbacks await that open if necessary.
 * Navigation hides a retained page; explicit close retires only its owner.
 * Failed operations stay registered for a user-triggered retry.
 */
export class BrowserSurfaceGuard {
  private readonly surfaces = new Set<Surface>();
  private readonly holds = new Set<Hold>();
  private readonly listeners = new Set<() => void>();
  private closing = false;
  private failed = false;
  private closeRequested = false;
  private navigationSequence = 0;
  private navigation: { sequence: number; action: () => void } | null = null;
  private snapshot: BrowserSurfaceSnapshot = Object.freeze({
    busy: false,
    failed: false,
    blocked: false,
  });

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): BrowserSurfaceSnapshot => this.snapshot;

  get canOpen(): boolean {
    return !this.snapshot.blocked;
  }

  get hasPendingNavigation(): boolean {
    return this.navigation !== null;
  }

  get hasSurfaces(): boolean {
    return this.surfaces.size > 0;
  }

  register(
    close: () => Promise<void>,
    hide?: () => Promise<void>,
  ): BrowserSurfaceRegistration {
    const surface: Surface = {
      close,
      hide,
      hidden: false,
      closeRequested: false,
      failed: false,
    };
    this.surfaces.add(surface);
    for (const hold of this.holds) hold.ready = false;
    this.publish(true);
    this.advance();
    return {
      release: () => {
        if (!this.surfaces.delete(surface)) return;
        this.failed = [...this.surfaces].some((owner) => owner.failed);
        this.publish(true);
        this.advance();
      },
      reveal: () => {
        if (!this.surfaces.has(surface) || !this.canOpen) return false;
        surface.hidden = false;
        return true;
      },
      requestClose: () => {
        if (!this.surfaces.has(surface)) return;
        surface.closeRequested = true;
        this.advance();
      },
    };
  }

  /** Latest navigation wins; without a native surface this runs synchronously. */
  runLatest(action: () => void): void {
    this.navigation = { sequence: ++this.navigationSequence, action };
    this.advance();
  }

  /** Cleanup must not replace a navigation already waiting for close. */
  requestClose(): void {
    this.closeRequested = true;
    this.advance();
  }

  /** Blocks new opens until release, including after all native pages close. */
  hold(): BrowserSurfaceHold {
    const hold: Hold = { active: true, ready: false };
    this.holds.add(hold);
    this.advance();
    return {
      get ready() {
        return hold.active && hold.ready;
      },
      release: () => {
        if (!hold.active) return;
        hold.active = false;
        hold.ready = false;
        this.holds.delete(hold);
        this.publish(true);
        this.advance();
      },
    };
  }

  retry(): void {
    if (this.closing || !this.failed) return;
    this.failed = false;
    // A failed hide cannot safely resume. Retry closes the exact failed owners.
    for (const owner of this.surfaces) {
      if (owner.failed) owner.closeRequested = true;
    }
    this.advance();
  }

  private advance(): void {
    if (this.closing || this.failed) {
      this.publish();
      return;
    }
    const hideRequested = this.navigation !== null || this.holds.size > 0;
    const owners = [...this.surfaces].filter(
      (owner) =>
        this.closeRequested ||
        owner.closeRequested ||
        (hideRequested && !owner.hidden),
    );
    if (owners.length > 0) {
      this.startTransition(owners);
      return;
    }

    this.closeRequested = false;
    let changed = false;
    for (const hold of this.holds) {
      if (!hold.ready) changed = true;
      hold.ready = true;
    }
    const navigation = this.navigation;
    this.navigation = null;
    this.publish(changed);
    // A notification can itself request newer navigation. Never revive its
    // predecessor, even when both transitions require no native close.
    if (navigation?.sequence === this.navigationSequence) navigation.action();
  }

  private startTransition(owners: Surface[]): void {
    const closeAll = this.closeRequested;
    this.closing = true;
    this.failed = false;
    for (const owner of owners) owner.failed = false;
    this.publish();
    const pending = owners.map((owner) => {
      const closing = closeAll || owner.closeRequested || !owner.hide;
      let operation: Promise<void>;
      try {
        operation = closing ? owner.close() : owner.hide!();
      } catch {
        operation = Promise.reject();
      }
      return Promise.resolve(operation).then(
        () => {
          if (closing) this.surfaces.delete(owner);
          else owner.hidden = true;
        },
        () => {
          // A component may already have confirmed and released this owner.
          if (this.surfaces.has(owner)) owner.failed = true;
        },
      );
    });
    void Promise.all(pending).then(() => {
      this.closing = false;
      this.failed = [...this.surfaces].some((owner) => owner.failed);
      this.publish(true);
      this.advance();
    });
  }

  private publish(force = false): void {
    const next: BrowserSurfaceSnapshot = {
      busy: this.closing,
      failed: this.failed,
      blocked:
        this.closing ||
        this.failed ||
        this.closeRequested ||
        [...this.surfaces].some((owner) => owner.closeRequested) ||
        this.navigation !== null ||
        this.holds.size > 0,
    };
    const changed =
      next.busy !== this.snapshot.busy ||
      next.failed !== this.snapshot.failed ||
      next.blocked !== this.snapshot.blocked;
    if (changed) this.snapshot = Object.freeze(next);
    if (changed || force) {
      for (const listener of [...this.listeners]) listener();
    }
  }
}
