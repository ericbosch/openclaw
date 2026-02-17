/**
 * Read the short ACK phrase from workspace ACK_STYLE.json (generic, no LLM).
 * Used to send immediate text feedback when a message is received; phrase is
 * bootstrapped once per agent/language and then reused.
 */

import fs from "node:fs/promises";
import path from "node:path";

const ACK_STYLE_FILENAME = "ACK_STYLE.json";

/**
 * Returns the `ack` string from workspace ACK_STYLE.json, or null if missing/invalid.
 * Trims and returns null for empty string.
 */
export async function readAckStylePhrase(workspaceDir: string): Promise<string | null> {
  const filePath = path.join(workspaceDir, ACK_STYLE_FILENAME);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(raw) as { ack?: unknown };
    const ack = data?.ack;
    if (typeof ack !== "string") {
      return null;
    }
    const trimmed = ack.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
