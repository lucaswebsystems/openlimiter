export type CardOrderScope =
  | { kind: "user"; id: string }
  | { kind: "paired"; id: string }
  | { kind: "demo" };

export interface CardOrderStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_PREFIX = "openlimiter-card-order-v1:";

function unique(keys: readonly string[]): string[] {
  return [...new Set(keys.filter((key) => key !== ""))];
}

export function cardOrderStorageKey(scope: CardOrderScope): string {
  const suffix = scope.kind === "demo" ? "demo" : `${scope.kind}:${encodeURIComponent(scope.id)}`;
  return STORAGE_PREFIX + suffix;
}

export function readCardOrder(
  storage: CardOrderStorage | null,
  scope: CardOrderScope,
): readonly string[] {
  if (storage === null) return [];
  try {
    const raw = storage.getItem(cardOrderStorageKey(scope));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? unique(parsed.filter((key): key is string => typeof key === "string"))
      : [];
  } catch {
    return [];
  }
}

/**
 * Merge what is on screen into saved order without dropping temporarily absent
 * accounts. New accounts append in the engine's current provider order.
 */
export function reconcileCardOrder(
  saved: readonly string[],
  present: readonly string[],
): readonly string[] {
  const order = unique(saved);
  const known = new Set(order);
  for (const key of unique(present)) {
    if (!known.has(key)) {
      known.add(key);
      order.push(key);
    }
  }
  return order;
}

export function visibleCardOrder(
  order: readonly string[],
  present: readonly string[],
): readonly string[] {
  const presentSet = new Set(present);
  return order.filter((key) => presentSet.has(key));
}

/** Move one visible card while leaving absent keys in their saved slots. */
export function moveVisibleCard(
  order: readonly string[],
  present: readonly string[],
  key: string,
  toIndex: number,
): readonly string[] {
  const visible = visibleCardOrder(order, present);
  const fromIndex = visible.indexOf(key);
  if (fromIndex < 0 || visible.length < 2) return order;
  const bounded = Math.max(0, Math.min(visible.length - 1, toIndex));
  if (bounded === fromIndex) return order;
  const moved = [...visible];
  moved.splice(fromIndex, 1);
  moved.splice(bounded, 0, key);
  let visibleIndex = 0;
  const presentSet = new Set(present);
  return order.map((entry) => presentSet.has(entry) ? moved[visibleIndex++] ?? entry : entry);
}

export function writeCardOrder(
  storage: CardOrderStorage | null,
  scope: CardOrderScope,
  order: readonly string[],
  present: readonly string[],
): void {
  /* A loading or first server render cannot erase a useful saved order. */
  if (storage === null || present.length === 0) return;
  try {
    storage.setItem(cardOrderStorageKey(scope), JSON.stringify(unique(order)));
  } catch {
    /* Refused storage changes only persistence, never the grid itself. */
  }
}

/** Only a caller holding an authoritative account list may prune saved keys. */
export function pruneCardOrder(
  order: readonly string[],
  authoritativeKeys: readonly string[],
): readonly string[] {
  const keep = new Set(authoritativeKeys);
  return order.filter((key) => keep.has(key));
}
