/** One transient UI owner, unrelated to Agent/session identity or persistence. */
export class DraftLocationOwner {
  private context: string | null = null;
  private active = false;
  private token: object | null = null;
  observe(context: string, active: boolean) {
    if (this.context !== context || this.active !== active) this.retire();
    this.context = context;
    this.active = active;
  }
  begin(): object | null {
    this.retire();
    return this.active ? (this.token = {}) : null;
  }
  owns(token: object | null) {
    return token !== null && this.active && this.token === token;
  }
  retire() {
    this.token = null;
  }
}
