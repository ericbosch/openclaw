import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const runEmbeddedPiAgentMock = vi.hoisted(() => vi.fn());

vi.mock("../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
}));

import { generateSlugViaLLM } from "./llm-slug-generator.js";

describe("generateSlugViaLLM", () => {
  it("uses agent primary model when configured", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "support-ticket" }],
      meta: {},
    });

    const cfg = {
      agents: {
        defaults: {
          workspace: "/tmp/openclaw-test-workspace",
          model: { primary: "ollama/qwen3:8b" },
        },
      },
    } satisfies OpenClawConfig;

    const slug = await generateSlugViaLLM({
      sessionContent: "user: hola\nassistant: dime",
      cfg,
    });

    expect(slug).toBe("support-ticket");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "ollama",
        model: "qwen3:8b",
      }),
    );
  });

  it("does not force provider/model when primary model is missing", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "quick-note" }],
      meta: {},
    });

    const cfg = {
      agents: { defaults: { workspace: "/tmp/openclaw-test-workspace" } },
    } satisfies OpenClawConfig;

    await generateSlugViaLLM({
      sessionContent: "user: hello",
      cfg,
    });

    const callArg = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(callArg?.provider).toBeUndefined();
    expect(callArg?.model).toBeUndefined();
  });
});
