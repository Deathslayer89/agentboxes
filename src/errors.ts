// One base class so the HTTP layer can tell expected errors (mapped to a status code)
// from bugs (500 plus a stack trace in the log).
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {}
export class ValidationError extends DomainError {}
export class ConflictError extends DomainError {}

// The server's cap on live sandboxes has been reached.
export class LimitExceededError extends DomainError {}

// gVisor (runsc) is not registered with Docker, or Docker cannot be reached.
export class RuntimeUnavailableError extends DomainError {}
