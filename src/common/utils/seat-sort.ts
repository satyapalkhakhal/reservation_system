const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'variant' });

/** Human-friendly display order (A2 before A10). Not used for lock ordering. */
export function compareSeatsForDisplay(a: string, b: string): number {
  return collator.compare(a, b);
}
