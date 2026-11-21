/**
 * One base class so the HTTP layer can tell expected errors (mapped to a status code)
 * from bugs (500 plus a stack trace in the log).
 */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {}
export class ValidationError extends DomainError {}
export class ConflictError extends DomainError {}
export class UnauthorizedError extends DomainError {}

// The caller is authenticated but not allowed to use this resource, for example a secret not bound to their API key.
export class ForbiddenError extends DomainError {}

// The server's cap on live sandboxes has been reached.
export class LimitExceededError extends DomainError {}

// An uploaded file or archive is larger than the configured limit.
export class PayloadTooLargeError extends DomainError {}

// gVisor (runsc) is not registered with Docker, or Docker cannot be reached.
export class RuntimeUnavailableError extends DomainError {}

// A dependency the request needs is temporarily down, for example the egress proxy after a crash.
export class ServiceUnavailableError extends DomainError {}
