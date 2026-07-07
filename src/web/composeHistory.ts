/**
 * Upper bound on remembered compose entries per session; oldest entries are
 * dropped first. Bounds memory for long-lived dashboard tabs.
 */
export const MAX_COMPOSE_HISTORY = 50;

/**
 * Returns a new history with `text` recorded as the most recent entry (last).
 * Empty text is ignored, exact duplicates are de-duplicated (the existing copy
 * is moved to the end), and the list is capped to {@link MAX_COMPOSE_HISTORY}.
 * The input array is never mutated.
 */
export function addComposeEntry(history: string[], text: string): string[] {
  if (text.length === 0) {
    return history;
  }
  const withoutDuplicate = history.filter((entry) => entry !== text);
  withoutDuplicate.push(text);
  if (withoutDuplicate.length > MAX_COMPOSE_HISTORY) {
    return withoutDuplicate.slice(withoutDuplicate.length - MAX_COMPOSE_HISTORY);
  }
  return withoutDuplicate;
}
