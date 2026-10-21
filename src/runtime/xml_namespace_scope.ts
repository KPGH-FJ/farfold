export type XmlNamespaceScope = Readonly<Record<string, string>>;

const emptyScope: XmlNamespaceScope = Object.freeze(Object.create(null));

/** Lookup-only parser scopes: own keys are local declarations. Inherited
 * declarations stay shared, not copied into every descendant XML node.
 * These scopes remain inside parsing; do not enumerate them as a full list. */
export function extendXmlNamespaceScope(
  parent: XmlNamespaceScope | undefined,
  local: Readonly<Record<string, string>>,
): XmlNamespaceScope {
  const keys = Object.keys(local);
  if (!keys.length) return parent ?? emptyScope;
  const scope: Record<string, string> = Object.create(parent ?? emptyScope);
  for (const key of keys) {
    // Define own data properties so frozen inherited bindings can be shadowed,
    // and names such as __proto__ never invoke a prototype setter.
    Object.defineProperty(scope, key, { value: local[key], enumerable: true });
  }
  return Object.freeze(scope);
}
