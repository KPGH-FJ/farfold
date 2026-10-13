import {
  BrowserWorkspaceRetiredError,
  BrowserWorkspaceSelectionChangedError,
  type BrowserWorkspaceClient,
  type BrowserWorkspacePageClient,
  type BrowserWorkspaceState,
  type BrowserWorkspaceTabsState,
} from "./browser_workspace";

export interface BrowserTab {
  id: string;
  page: BrowserWorkspaceState | null;
  opening: boolean;
  closing: boolean;
}
export interface BrowserTabsSnapshot {
  tabs: readonly BrowserTab[];
  selected: string;
  changing: boolean;
  failed: boolean;
  ready: boolean;
}

/** Only live UI/native owners. No page body, permission grant or durable list. */
export class BrowserTabs {
  private next = 0;
  private intent = 0;
  private retired = false;
  private refreshSequence = 0;
  private listenSequence = 0;
  private listening = false;
  private stopListening: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private clients = new Map<string, BrowserWorkspacePageClient>();
  private active = true;
  private closers = new Map<string, () => Promise<void>>();
  private opening = new Map<string, Promise<BrowserWorkspaceState>>();
  private server: BrowserWorkspaceTabsState;
  private snapshot: BrowserTabsSnapshot;

  constructor(
    readonly client: BrowserWorkspaceClient,
    readonly taskKey: string,
  ) {
    const first = this.blank();
    this.snapshot = {
      tabs: [first],
      selected: first.id,
      changing: false,
      failed: false,
      ready: false,
    };
    this.server = {
      taskKey,
      pages: [],
      selection: { label: null, revision: 0 },
    };
  }
  private blank(): BrowserTab {
    return {
      id: `tab-${++this.next}`,
      page: null,
      opening: false,
      closing: false,
    };
  }
  readonly getSnapshot = () => this.snapshot;
  setActive(active: boolean) {
    if (this.active && !active) ++this.intent;
    this.active = active;
  }
  registerCloser(id: string, close: (() => Promise<void>) | null) {
    if (close) this.closers.set(id, close);
    else this.closers.delete(id);
  }
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<BrowserTabsSnapshot>) {
    if (this.retired) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  private tab(id: string) {
    return this.snapshot.tabs.find((tab) => tab.id === id);
  }
  private patchTab(id: string, patch: Partial<BrowserTab>) {
    this.publish({
      tabs: this.snapshot.tabs.map((tab) =>
        tab.id === id ? { ...tab, ...patch } : tab,
      ),
    });
  }
  private accept(state: BrowserWorkspaceTabsState) {
    if (
      this.retired ||
      state.taskKey !== this.taskKey ||
      state.selection.revision < this.server.selection.revision
    )
      throw new BrowserWorkspaceRetiredError();
    this.server = state;
    const tabs = this.snapshot.tabs.map((tab) => {
      const page = state.pages.find((page) => page.label === tab.page?.label);
      return page ? { ...tab, page } : tab;
    });
    // Reservations can be announced before open returns its identity. Never
    // guess which concurrent opener owns one; resolve from the actual reply.
    if (!this.opening.size) {
      for (const page of state.pages) {
        if (!tabs.some((tab) => tab.page?.label === page.label))
          tabs.push({ ...this.blank(), page });
      }
    }
    this.publish({ tabs, ready: true });
  }
  async refresh() {
    const sequence = ++this.refreshSequence;
    const state = await this.client.tabs({ taskKey: this.taskKey });
    if (this.retired || sequence !== this.refreshSequence) return;
    this.accept(state);
  }
  async start(): Promise<() => void> {
    const sequence = ++this.listenSequence;
    this.retired = false;
    this.stopListening?.();
    this.stopListening = null;
    this.listening = false;
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await this.client.listenTabsChanged(({ taskKey }) => {
        if (
          !this.retired &&
          sequence === this.listenSequence &&
          taskKey === this.taskKey
        )
          void this.refresh().catch(() => this.publish({ failed: true }));
      });
      if (this.retired || sequence !== this.listenSequence) {
        unlisten();
        return () => {};
      }
      this.stopListening = unlisten;
      this.listening = true;
      await this.refresh();
    } catch {
      if (sequence === this.listenSequence) this.publish({ failed: true });
    }
    return () => {
      if (sequence === this.listenSequence) {
        this.listening = false;
        this.stopListening = null;
        ++this.listenSequence;
      }
      unlisten?.();
    };
  }
  private async nativeSelect(label: string | null) {
    // Resynchronize after a prior close/error. Never turn a stale selection
    // response into an automatic second request.
    const current = await this.client.tabs({ taskKey: this.taskKey });
    this.accept(current);
    const result = await this.client.select({
      taskKey: this.taskKey,
      label,
      expectedSelected: { ...current.selection },
    });
    this.accept(result);
  }
  private async change(id: string) {
    const tab = this.tab(id);
    if (
      !tab ||
      tab.closing ||
      this.retired ||
      !this.active ||
      this.snapshot.changing
    )
      return;
    if (
      id === this.snapshot.selected &&
      !this.snapshot.failed &&
      this.server.selection.label === (tab.page?.label ?? null)
    )
      return;
    ++this.intent;
    this.publish({ changing: true, failed: false });
    try {
      if (!this.listening) await this.start();
      if (!this.listening) throw new BrowserWorkspaceRetiredError();
      await this.nativeSelect(tab.page?.label ?? null);
      // Task hiding does not cancel this explicit page choice. It only prevents
      // presentation; publish the acknowledged selection without showing it.
      if (!this.retired && this.tab(id)) this.publish({ selected: id });
    } catch {
      this.publish({ failed: true });
      await this.refresh().catch(() => {});
    } finally {
      this.publish({ changing: false });
    }
  }
  select(id: string) {
    return this.change(id);
  }
  async add() {
    if (this.snapshot.changing || this.retired) return;
    const tab = this.blank();
    this.publish({ tabs: [...this.snapshot.tabs, tab] });
    await this.change(tab.id);
  }
  isSelected(id: string) {
    return this.server.selection.label === (this.tab(id)?.page?.label ?? null);
  }
  canPresent(id: string) {
    return (
      !this.retired &&
      this.active &&
      this.snapshot.ready &&
      !this.snapshot.changing &&
      !this.snapshot.failed &&
      this.snapshot.selected === id &&
      this.isSelected(id)
    );
  }
  async close(id: string) {
    const tab = this.tab(id);
    if (!tab || tab.closing || this.snapshot.changing) return;
    const index = this.snapshot.tabs.indexOf(tab);
    ++this.intent;
    this.publish({ changing: true });
    this.patchTab(id, { closing: true });
    try {
      try {
        await this.opening.get(id);
      } catch {
        /* Exact known owner stays below. */
      }
      const page = this.tab(id)?.page;
      const closer = this.closers.get(id);
      if (closer) await closer();
      else if (page && page.phase !== "closed")
        await this.client.close({ taskKey: this.taskKey, label: page.label });
      this.clients.delete(id);
      this.closers.delete(id);
      const tabs = this.snapshot.tabs.filter((tab) => tab.id !== id);
      if (!tabs.length) tabs.push(this.blank());
      const selected =
        this.snapshot.selected === id
          ? tabs[Math.min(index, tabs.length - 1)].id
          : this.snapshot.selected;
      const replacingSelected = selected !== this.snapshot.selected;
      // The close ACK definitively removes this owner. Keep a valid local
      // successor even if the following native selection fails or the task hid.
      // Retain the transaction lock through its selection ACK, so a later user
      // choice cannot be overwritten by this close continuation.
      this.publish({ tabs, selected, failed: false });
      await this.refresh();
      if (replacingSelected && !this.retired)
        await this.nativeSelect(this.tab(selected)?.page?.label ?? null);
    } catch {
      this.patchTab(id, { closing: false });
      this.publish({ failed: true });
      await this.refresh().catch(() => {});
    } finally {
      this.publish({ changing: false });
    }
  }
  observe(id: string, page: BrowserWorkspaceState | null) {
    const old = this.tab(id)?.page;
    if (
      page &&
      (page.taskKey !== this.taskKey ||
        (old?.label === page.label && old.revision > page.revision))
    )
      return;
    if (!page && (this.tab(id)?.opening || old)) return;
    if (page)
      this.patchTab(id, { page: page.phase === "closed" ? null : page });
  }
  pageClient(id: string): BrowserWorkspacePageClient {
    const existing = this.clients.get(id);
    if (existing) return existing;
    const open = (create: () => Promise<BrowserWorkspaceState>) => {
      const intent = this.intent;
      this.patchTab(id, { opening: true });
      const pending = Promise.resolve()
        .then(create)
        .then(async (page) => {
          if (page.taskKey !== this.taskKey)
            throw new BrowserWorkspaceRetiredError();
          this.patchTab(id, { page });
          // Return identity even after retirement: the already-registered PageScope
          // must own the real close and retain that identity if close fails.
          if (this.retired || !this.tab(id)) return page;
          if (
            this.active &&
            intent === this.intent &&
            this.snapshot.selected === id &&
            !this.tab(id)?.closing
          ) {
            this.publish({ changing: true });
            try {
              await this.nativeSelect(page.label);
            } catch {
              this.publish({ failed: true });
              await this.refresh().catch(() => {});
            } finally {
              this.publish({ changing: false });
            }
          }
          return page;
        })
        .finally(() => {
          this.opening.delete(id);
          this.patchTab(id, { opening: false });
          // A rejected create may still leave a backend reservation. Discover its
          // exact identity only after this opener can no longer claim it.
          void this.refresh().catch(() => this.publish({ failed: true }));
        });
      this.opening.set(id, pending);
      return pending;
    };
    const base = this.client;
    const client: BrowserWorkspacePageClient = {
      ...base,
      open: (input) => open(() => base.open(input)),
      openHtml: (input) => open(() => base.openHtml(input)),
      openDirectory: base.openDirectory
        ? (input) => open(() => base.openDirectory!(input))
        : undefined,
      openDevelopment: base.openDevelopment
        ? (input) => open(() => base.openDevelopment!(input))
        : undefined,
      setVisible: async (input) => {
        if (!input.visible) return base.setVisible(input);
        const revision = this.server.selection.revision;
        const current = () =>
          this.canPresent(id) &&
          this.server.selection.label === input.label &&
          this.server.selection.revision === revision;
        if (!current()) throw new BrowserWorkspaceSelectionChangedError();
        try {
          await base.setVisible(input);
        } catch (error) {
          if (!current()) throw new BrowserWorkspaceSelectionChangedError();
          throw error;
        }
        if (!current()) throw new BrowserWorkspaceSelectionChangedError();
      },
      snapshot: async (input) => {
        const selection = { ...this.server.selection };
        if (!this.canPresent(id) || selection.label !== input.label)
          throw new BrowserWorkspaceRetiredError();
        const result = await base.snapshot(input);
        const current = await base.tabs({ taskKey: this.taskKey });
        if (
          !this.canPresent(id) ||
          current.selection.revision !== selection.revision ||
          current.selection.label !== selection.label
        )
          throw new BrowserWorkspaceRetiredError();
        return result;
      },
      clearHtmlStorage: async (input) => {
        await base.clearHtmlStorage(input);
        if (this.tab(id)?.page?.label === input.label)
          this.patchTab(id, { page: null });
        await this.refresh();
      },
      close: async (input) => {
        await base.close(input);
        if (this.tab(id)?.page?.label === input.label)
          this.patchTab(id, { page: null });
        await this.refresh();
      },
    };
    this.clients.set(id, client);
    return client;
  }
  retire() {
    this.retired = true;
    ++this.intent;
    ++this.listenSequence;
    this.stopListening?.();
    this.stopListening = null;
    this.listening = false;
    this.listeners.clear();
    // Mounted page scopes/guard own exact close ACK, including their late opens.
  }
}
