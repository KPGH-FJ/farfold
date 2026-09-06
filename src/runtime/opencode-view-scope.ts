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
