/** In-memory ownership for a search-only disclosure. No transcript storage. */
export class SearchExpansion {
  userOpen: boolean;
  private revealOwner: object | null = null;
  constructor(
    initial = false,
    readonly changed: () => void = () => {},
  ) {
    this.userOpen = initial;
  }
  get open() {
    return this.userOpen || this.revealOwner !== null;
  }
  choose(value: boolean) {
    this.userOpen = value;
    this.revealOwner = null;
    this.changed();
  }
  reveal(): () => void {
    const owner = {};
    this.revealOwner = owner;
    this.changed();
    return () => {
      if (this.revealOwner !== owner) return;
      this.revealOwner = null;
      this.changed();
    };
  }
}

const disclosures = new WeakMap<HTMLElement, SearchExpansion>();
export function registerSearchExpansion(
  element: HTMLElement,
  model: SearchExpansion,
) {
  disclosures.set(element, model);
  return () => {
    if (disclosures.get(element) === model) disclosures.delete(element);
  };
}
/** Only ancestors within this transcript may be changed; release is owner-bound. */
export function revealSearchAncestors(element: HTMLElement, root: HTMLElement) {
  if (!root.contains(element)) return () => {};
  const parents: SearchExpansion[] = [];
  for (
    let node: HTMLElement | null = element;
    node && root.contains(node);
    node = node.parentElement
  ) {
    const model = disclosures.get(node);
    if (model) parents.push(model);
    if (node === root) break;
  }
  const releases = parents.reverse().map((model) => model.reveal());
  return () => releases.reverse().forEach((release) => release());
}

/** A user opening a nested result keeps its visible ancestry open as well. This
 * preserves that choice when search-only children would otherwise unmount. */
export function keepSearchAncestors(element: HTMLElement) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const model = disclosures.get(node);
    if (model?.open && !model.userOpen) model.choose(true);
  }
}
