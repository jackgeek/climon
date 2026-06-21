import { describe, expect, test } from "bun:test";
import { formatExpiryCountdown } from "../src/web/tunnelExpiry.js";

const HOUR_MS = 3_600_000;

describe("formatExpiryCountdown", () => {
  test("shows days, hours, minutes when over a day remains", () => {
    const ms = ((29 * 24 + 23) * 60 + 14) * 60 * 1000;
    expect(formatExpiryCountdown(ms)).toEqual({
      text: "Tunnel link expires in 29d 23h 14m",
      level: "info"
    });
  });

  test("drops the days unit when under a day remains", () => {
    const ms = (5 * 60 + 22) * 60 * 1000;
    expect(formatExpiryCountdown(ms)).toEqual({
      text: "Tunnel link expires in 5h 22m",
      level: "info"
    });
  });

  test("exactly one hour is still the info format", () => {
    expect(formatExpiryCountdown(HOUR_MS)).toEqual({
      text: "Tunnel link expires in 1h 0m",
      level: "info"
    });
  });

  test("under an hour switches to warn with zero-padded minutes and seconds", () => {
    const ms = (4 * 60 + 32) * 1000;
    expect(formatExpiryCountdown(ms)).toEqual({
      text: "Tunnel link expires in 04m 32s",
      level: "warn"
    });
  });

  test("pads single-digit seconds with a leading zero", () => {
    expect(formatExpiryCountdown(9_000)).toEqual({
      text: "Tunnel link expires in 00m 09s",
      level: "warn"
    });
  });

  test("zero remaining is expired", () => {
    expect(formatExpiryCountdown(0)).toEqual({
      text: "Tunnel link expired",
      level: "expired"
    });
  });

  test("negative remaining is expired", () => {
    expect(formatExpiryCountdown(-5_000)).toEqual({
      text: "Tunnel link expired",
      level: "expired"
    });
  });
});
