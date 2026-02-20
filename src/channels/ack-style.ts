/**
 * Read the short ACK phrase from workspace ACK_STYLE.json (generic, no LLM).
 * Used to send immediate text feedback when a message is received.
 * Supports a single string or an array of phrases; when array, one is chosen at random
 * so replies sound more natural across messages.
 */

import fs from "node:fs/promises";
import path from "node:path";

const ACK_STYLE_FILENAME = "ACK_STYLE.json";

function pickOne(ack: unknown): string | null {
  if (ack == null) {
    return null;
  }
  if (typeof ack === "string") {
    const trimmed = ack.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(ack)) {
    const nonEmpty = ack
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (nonEmpty.length === 0) {
      return null;
    }
    return nonEmpty[Math.floor(Math.random() * nonEmpty.length)] ?? null;
  }
  return null;
}

/**
 * Returns one ACK phrase from workspace ACK_STYLE.json, or null if missing/invalid.
 * If `ack` is an array, a random entry is chosen each time for variety.
 */
export async function readAckStylePhrase(workspaceDir: string): Promise<string | null> {
  const filePath = path.join(workspaceDir, ACK_STYLE_FILENAME);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(raw) as { ack?: unknown };
    return pickOne(data?.ack);
  } catch {
    return null;
  }
}
