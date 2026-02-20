import { describe, expect, it } from "vitest";
import { resolveMaxTotalWaitMs, resolveMaxWaitRetryDelayMs } from "./agent-runner-execution.js";

describe("agent-runner max wait helpers", () => {
  it("uses minimum 150s when timeout is missing or small", () => {
    expect(resolveMaxTotalWaitMs(undefined)).toBe(150_000);
    expect(resolveMaxTotalWaitMs(0)).toBe(150_000);
    expect(resolveMaxTotalWaitMs(30_000)).toBe(150_000);
    expect(resolveMaxTotalWaitMs(89_000)).toBe(150_000);
  });

  it("uses timeout + 60s when timeout is large enough", () => {
    expect(resolveMaxTotalWaitMs(90_001)).toBe(150_001);
    expect(resolveMaxTotalWaitMs(900_000)).toBe(960_000);
  });

  it("derives retry hint delay from max wait with 30s floor", () => {
    expect(resolveMaxWaitRetryDelayMs(150_000)).toBe(30_000);
    expect(resolveMaxWaitRetryDelayMs(960_000)).toBe(160_000);
  });
});
