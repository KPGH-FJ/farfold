// Fences asynchronous presentation work when the Host replaces an OpenCode
// Session. This never starts, stops, or owns a Runtime.
export class OpenCodeViewScope {
  private revision = 0;
  private transitioning = false;

  pause(): void {
    this.revision += 1;
    this.transitioning = true;
  }

  resume(): void {
    this.transitioning = false;
  }

  capture(): number | null {
    return this.transitioning ? null : this.revision;
  }

  isCurrent(revision: number | null): boolean {
    return (
      revision !== null && !this.transitioning && revision === this.revision
    );
  }
}

// Activity reads may overlap within the same native Session (e.g. error recovery and Stop).
export class OpenCodeActivityReadScope {
  private revision = 0;
  begin(): number {
    return ++this.revision;
  }
  invalidate(): void {
    this.revision += 1;
  }
  isCurrent(revision: number): boolean {
    return revision === this.revision;
  }
}
