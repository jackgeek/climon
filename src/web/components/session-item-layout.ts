export type BottomRowButton = "new" | "edit" | "pause" | "lock";

const SLOT_BASE = 8;
const SLOT_STRIDE = 28;

/**
 * Computes the `right` pixel offset for each visible bottom-row action button.
 * Buttons are laid out right-to-left in visual order [new, edit, pause, lock].
 * When `includeNew` is false the new button is dropped and the remaining
 * buttons shift right (toward 8px) so no gap is left at the rightmost slot.
 */
export function bottomRowRightOffsets(includeNew: boolean): Partial<Record<BottomRowButton, number>> {
  const order: BottomRowButton[] = includeNew
    ? ["new", "edit", "pause", "lock"]
    : ["edit", "pause", "lock"];
  const offsets: Partial<Record<BottomRowButton, number>> = {};
  order.forEach((name, index) => {
    offsets[name] = SLOT_BASE + index * SLOT_STRIDE;
  });
  return offsets;
}
