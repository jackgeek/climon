/**
 * Single source of truth for the mobile-view breakpoint. The dashboard treats
 * viewports at or below this width as "mobile" (stacked layout, offscreen
 * terminal until maximized). Both the JS `matchMedia` detection (`useIsMobile`)
 * and the Griffel `makeStyles` `@media` keys derive from these values so the
 * breakpoint changes in exactly one place.
 */
export const MOBILE_MAX_WIDTH_PX = 768;

export const MOBILE_MEDIA_QUERY = `(max-width: ${MOBILE_MAX_WIDTH_PX}px)`;

/**
 * The same breakpoint as a Griffel/`makeStyles` at-rule key. `makeStyles`
 * media keys MUST include the `@media ` prefix (unlike `window.matchMedia`,
 * which takes the bare query), so this is the form to use for style slots.
 */
export const MOBILE_MEDIA_QUERY_RULE = `@media ${MOBILE_MEDIA_QUERY}`;
