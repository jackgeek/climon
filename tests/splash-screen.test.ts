import { expect, test } from "bun:test";
import { SPLASH_HOLD_MS } from "../src/web/components/SplashScreen";

test("holds the splash screen for 1 second before fading", () => {
  expect(SPLASH_HOLD_MS).toBe(1000);
});
