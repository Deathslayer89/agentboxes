import { randomBytes } from "node:crypto";

export interface IdGenerator {
  next(): string;
}

// Predictable ids for tests: sbx_1, sbx_2, ...
export class CounterIdGenerator implements IdGenerator {
  private counter = 0;

  constructor(private readonly prefix: string) {}

  next(): string {
    this.counter += 1;
    return this.prefix + this.counter.toString();
  }
}

// prefix plus 12 hex chars (48 random bits): short enough to type into curl,
// random enough that a caller cannot guess another caller's sandbox id.
export class RandomIdGenerator implements IdGenerator {
  constructor(private readonly prefix: string) {}

  next(): string {
    return this.prefix + randomBytes(6).toString("hex");
  }
}
