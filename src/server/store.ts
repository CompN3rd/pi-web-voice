import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, open, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Command, Worker } from "../protocol.ts";

export interface Ledger {
  version: 1;
  workers: Worker[];
  receipts: { requestId: string; fingerprint: string; workerId: string }[];
}
export const scopeKey = (projectId: string, workspaceId: string) => createHash("sha256").update(JSON.stringify([projectId, workspaceId])).digest("hex");
export const fingerprint = (command: Command) => createHash("sha256").update(JSON.stringify(command)).digest("hex");
/** All callers use the service's single queue. Atomic replacement never exposes a half-written ledger. */
export class Store {
  constructor(private directory: string) {}
  async load(scope: string): Promise<Ledger> {
    try {
      const data = JSON.parse(await readFile(join(this.directory, `${scope}.json`), "utf8"));
      if (data.version !== 1 || !Array.isArray(data.workers) || !Array.isArray(data.receipts)) throw new Error("Unsupported voice ledger");
      return data as Ledger;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, workers: [], receipts: [] };
      throw error;
    }
  }
  async save(scope: string, ledger: Ledger): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, `${scope}.json`);
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(tmp, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(ledger), "utf8"); await file.sync(); }
      finally { await file.close(); }
      await rename(tmp, path);
    } catch (error) { await rm(tmp, { force: true }).catch(() => {}); throw error; }
  }
}
