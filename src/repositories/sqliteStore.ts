import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Sandbox } from "../models/sandbox.js";
import type { SandboxRepository } from "./sandboxRepository.js";

// Small named values the server needs across restarts, such as the egress proxy's admin token.
export interface SettingsRepository {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

/**
 * One SQLite file holding sandbox records and settings. Records are loaded once and served
 * from memory, so every lookup returns the same object and a save writes it through; that
 * keeps the in-memory semantics the service relies on while surviving a restart.
 */
export class SqliteStore {
  private readonly db: Database.Database;
  readonly sandboxes: SandboxRepository;
  readonly settings: SettingsRepository;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sandboxes (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.sandboxes = new SqliteSandboxRepository(this.db);
    this.settings = new SqliteSettings(this.db);
  }

  close(): void {
    this.db.close();
  }
}

class SqliteSandboxRepository implements SandboxRepository {
  private readonly cache = new Map<string, Sandbox>();
  private readonly upsert: Database.Statement;
  private readonly remove: Database.Statement;

  constructor(db: Database.Database) {
    this.upsert = db.prepare("INSERT INTO sandboxes (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data");
    this.remove = db.prepare("DELETE FROM sandboxes WHERE id = ?");
    for (const row of db.prepare("SELECT data FROM sandboxes").all() as Array<{ data: string }>) {
      const sandbox = deserialize(row.data);
      this.cache.set(sandbox.id, sandbox);
    }
  }

  save(sandbox: Sandbox): void {
    this.cache.set(sandbox.id, sandbox);
    this.upsert.run(sandbox.id, serialize(sandbox));
  }

  findById(id: string): Sandbox | undefined {
    return this.cache.get(id);
  }

  findAll(): Sandbox[] {
    return Array.from(this.cache.values());
  }

  delete(id: string): void {
    this.cache.delete(id);
    this.remove.run(id);
  }
}

class SqliteSettings implements SettingsRepository {
  private readonly select: Database.Statement;
  private readonly upsert: Database.Statement;

  constructor(db: Database.Database) {
    this.select = db.prepare("SELECT value FROM settings WHERE key = ?");
    this.upsert = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  }

  get(key: string): string | undefined {
    return (this.select.get(key) as { value: string } | undefined)?.value;
  }

  set(key: string, value: string): void {
    this.upsert.run(key, value);
  }
}

function serialize(sandbox: Sandbox): string {
  return JSON.stringify({ ...sandbox, createdAt: sandbox.createdAt.toISOString(), expiresAt: sandbox.expiresAt.toISOString() });
}

// A loaded record has no exec running any more: the process that ran it is gone.
function deserialize(data: string): Sandbox {
  const raw = JSON.parse(data) as Omit<Sandbox, "createdAt" | "expiresAt"> & { createdAt: string; expiresAt: string };
  return {
    ...raw,
    owner: raw.owner ?? "local",
    createdAt: new Date(raw.createdAt),
    expiresAt: new Date(raw.expiresAt),
    activeExecs: 0,
    status: raw.status === "busy" ? "ready" : raw.status,
  };
}
