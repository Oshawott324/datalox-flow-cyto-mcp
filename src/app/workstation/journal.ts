import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * The workstation's record of every change it writes to a workspace.
 *
 * One JSON line per write, next to the workspace file. Each line carries the
 * revision written and the SHA-256 of the file as written, so the history can
 * be checked against the workspace: an unbroken run of revisions, each one
 * recorded here, and a last line matching the file on disk mean every change
 * was made through the workstation. A line with action "open" marks each time
 * the workstation opened the workspace, and says whether the file still
 * matched the last recorded write.
 */
export type JournalEntry = {
  seq: number;
  at: string;
  origin: "gui";
  action: string;
  revision: number;
  sha256: string;
  detail?: Record<string, unknown>;
  /** On "open" lines: whether the file matched the last write recorded here (null when there is none). */
  matchesJournal?: boolean | null;
};

export function journalPathFor(workspacePath: string): string {
  const base = path.basename(workspacePath).replace(/\.json$/i, "");
  return path.join(path.dirname(path.resolve(workspacePath)), `${base}.journal.jsonl`);
}

export async function fileSha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

export async function readJournal(workspacePath: string): Promise<JournalEntry[]> {
  const raw = await fs.readFile(journalPathFor(workspacePath), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return raw.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as JournalEntry);
}

export class Journal {
  private seq = 0;

  private constructor(private readonly workspacePath: string) {}

  /** Open the journal for a workspace and record the opening. */
  static async open(workspacePath: string, revision: number): Promise<Journal> {
    const journal = new Journal(workspacePath);
    const entries = await readJournal(workspacePath);
    journal.seq = entries.at(-1)?.seq ?? -1;
    const sha256 = await fileSha256(workspacePath);
    const lastWrite = entries.at(-1);
    await journal.append({
      action: "open",
      revision,
      sha256,
      matchesJournal: lastWrite ? lastWrite.sha256 === sha256 && lastWrite.revision === revision : null,
    });
    return journal;
  }

  async record(action: string, revision: number, detail?: Record<string, unknown>): Promise<void> {
    await this.append({ action, revision, sha256: await fileSha256(this.workspacePath), ...(detail ? { detail } : {}) });
  }

  private async append(entry: Omit<JournalEntry, "seq" | "at" | "origin">): Promise<void> {
    this.seq += 1;
    const line: JournalEntry = { seq: this.seq, at: new Date().toISOString(), origin: "gui", ...entry };
    const handle = await fs.open(journalPathFor(this.workspacePath), "a");
    try {
      await handle.appendFile(`${JSON.stringify(line)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
