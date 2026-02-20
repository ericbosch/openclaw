import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAckStylePhrase } from "./ack-style.js";

const tempDirs: string[] = [];

async function createWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ack-style-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("readAckStylePhrase", () => {
  it("returns a trimmed ack string", async () => {
    const workspaceDir = await createWorkspace();
    await fs.writeFile(
      path.join(workspaceDir, "ACK_STYLE.json"),
      JSON.stringify({ ack: "  recibo, voy  " }),
      "utf8",
    );

    await expect(readAckStylePhrase(workspaceDir)).resolves.toBe("recibo, voy");
  });

  it("returns one value when ack is an array", async () => {
    const workspaceDir = await createWorkspace();
    await fs.writeFile(
      path.join(workspaceDir, "ACK_STYLE.json"),
      JSON.stringify({ ack: ["  ok  ", "voy"] }),
      "utf8",
    );

    const value = await readAckStylePhrase(workspaceDir);
    expect(["ok", "voy"]).toContain(value);
  });

  it("returns null when file is missing or invalid", async () => {
    const workspaceDir = await createWorkspace();
    await expect(readAckStylePhrase(workspaceDir)).resolves.toBeNull();

    await fs.writeFile(path.join(workspaceDir, "ACK_STYLE.json"), "{not json}", "utf8");
    await expect(readAckStylePhrase(workspaceDir)).resolves.toBeNull();
  });
});
