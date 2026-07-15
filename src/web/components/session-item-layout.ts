export type BottomRowButton = "new" | "edit" | "pause";

const SLOT_BASE = 8;
const SLOT_STRIDE = 28;

/**
 * Computes the `right` pixel offset for each visible bottom-row action button.
 * Buttons are laid out right-to-left in visual order [new, edit, pause].
 * When `includeNew` is false the new button is dropped and the remaining
 * buttons shift right (toward 8px) so no gap is left at the rightmost slot.
 */
export function bottomRowRightOffsets(includeNew: boolean): Partial<Record<BottomRowButton, number>> {
  const order: BottomRowButton[] = includeNew ? ["new", "edit", "pause"] : ["edit", "pause"];
  const offsets: Partial<Record<BottomRowButton, number>> = {};
  order.forEach((name, index) => {
    offsets[name] = SLOT_BASE + index * SLOT_STRIDE;
  });
  return offsets;
}
