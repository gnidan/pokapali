/**
 * Typed error classes for programmatic error handling.
 *
 * All extend PokapaliError for a convenient catch-all:
 *
 *   try { ... }
 *   catch (e) {
 *     if (e instanceof PermissionError) { ... }
 *     if (e instanceof PokapaliError) { ... }
 *   }
 */

export class PokapaliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PokapaliError";
  }
}

/** Thrown when the caller lacks the required
 *  capability (admin, readKey, channel key). */
export class PermissionError extends PokapaliError {
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}

/** Thrown when an operation exceeds its timeout. */
export class TimeoutError extends PokapaliError {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/** Thrown when calling methods on a destroyed Doc. */
export class DestroyedError extends PokapaliError {
  constructor(message: string) {
    super(message);
    this.name = "DestroyedError";
  }
}

/** Thrown when a URL, fragment, or record fails
 *  structural or cryptographic validation. */
export class ValidationError extends PokapaliError {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Thrown when a requested resource (block, version)
 *  cannot be found locally or on the network. */
export class NotFoundError extends PokapaliError {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
