import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

const sqlite = process.getBuiltinModule("node:sqlite") as
  typeof import("node:sqlite") | undefined;
export const draftSqliteAvailable = Boolean(sqlite);

/** A private database using the settings row layout and three SQLite connections. */
export function createDraftSqliteFixture() {
  if (!sqlite) throw new Error("node:sqlite is unavailable");
  const directory = mkdtempSync(join(tmpdir(), "farfold-draft-sqlite-"));
  const database = join(directory, "drafts.sqlite3");
  const key = "unsentWork.v1";
  let writer: DatabaseSync | undefined;
  let locker: DatabaseSync | undefined;
  const close = () => {
    try {
      locker?.close();
    } finally {
      try {
        writer?.close();
      } finally {
        rmSync(directory, { recursive: true });
      }
    }
  };
  try {
    writer = new sqlite.DatabaseSync(database);
    writer.exec(
      "PRAGMA journal_mode = WAL; CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    const save = writer.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
    );
    const { DatabaseSync } = sqlite;
    locker = new DatabaseSync(database);
    const lock = locker;
    return {
      key,
      read() {
        const reader = new DatabaseSync(database, { readOnly: true });
        try {
          return reader
            .prepare("SELECT value FROM settings WHERE key = ?")
            .get(key)?.value as string | undefined;
        } finally {
          reader.close();
        }
      },
      write(value: unknown) {
        save.run(key, JSON.stringify(value));
      },
      holdWriteLock() {
        lock.exec("BEGIN IMMEDIATE");
        return () => lock.exec("ROLLBACK");
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
