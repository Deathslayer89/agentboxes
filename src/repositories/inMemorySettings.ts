import type { SettingsRepository } from "./sqliteStore.js";

export class InMemorySettings implements SettingsRepository {
  private readonly values = new Map<string, string>();

  get(key: string): string | undefined {
    return this.values.get(key);
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
  }
}
