import type { Sandbox } from "../models/sandbox.js";

// Where sandbox records live. v0.1 keeps them in memory (a server restart forgets
// them; the reaper then removes their containers as orphans). v0.2 adds SQLite
// behind this same interface.
export interface SandboxRepository {
  save(sandbox: Sandbox): void;
  findById(id: string): Sandbox | undefined;
  findAll(): Sandbox[];
  delete(id: string): void;
}

export class InMemorySandboxRepository implements SandboxRepository {
  private readonly sandboxes = new Map<string, Sandbox>();

  save(sandbox: Sandbox): void {
    this.sandboxes.set(sandbox.id, sandbox);
  }

  findById(id: string): Sandbox | undefined {
    return this.sandboxes.get(id);
  }

  findAll(): Sandbox[] {
    return Array.from(this.sandboxes.values());
  }

  delete(id: string): void {
    this.sandboxes.delete(id);
  }
}
