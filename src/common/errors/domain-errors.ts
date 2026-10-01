/**
 * Expected, typed outcomes of business rules. The central error handler maps
 * these to HTTP responses; they are never logged as application errors.
 */
export abstract class DomainError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}

export class ValidationError extends DomainError {
  readonly statusCode = 400;
  readonly code = 'VALIDATION_ERROR';
}

export class UnauthenticatedError extends DomainError {
  readonly statusCode = 401;
  readonly code = 'UNAUTHENTICATED';
}

export class UnauthorizedReservationError extends DomainError {
  readonly statusCode = 403;
  readonly code = 'FORBIDDEN';
  constructor() {
    super('Reservation belongs to another user');
  }
}

export class ShowNotFoundError extends DomainError {
  readonly statusCode = 404;
  readonly code = 'SHOW_NOT_FOUND';
  constructor(showId: string) {
    super('Show not found', { show_id: showId });
  }
}

export class ReservationNotFoundError extends DomainError {
  readonly statusCode = 404;
  readonly code = 'RESERVATION_NOT_FOUND';
  constructor(reservationId: string) {
    super('Reservation not found', { reservation_id: reservationId });
  }
}

export class UnknownSeatsError extends DomainError {
  readonly statusCode = 422;
  readonly code = 'UNKNOWN_SEATS';
  constructor(seats: string[]) {
    super('One or more requested seats do not exist in this show', { seats });
  }
}

export class SeatTakenError extends DomainError {
  readonly statusCode = 409;
  readonly code = 'SEAT_TAKEN';
  constructor(seats: string[]) {
    super('One or more requested seats are not available', { seats });
  }
}

export class PerUserLimitError extends DomainError {
  readonly statusCode = 409;
  readonly code = 'PER_USER_LIMIT';
  constructor(limit: number, alreadyReserved: number, requested: number) {
    super('Reservation would exceed the per-user seat limit for this show', {
      per_user_limit: limit,
      already_reserved: alreadyReserved,
      requested,
    });
  }
}

export class IdempotencyConflictError extends DomainError {
  readonly statusCode = 409;
  readonly code = 'IDEMPOTENCY_CONFLICT';
  constructor() {
    super('Idempotency key was already used with a different request');
  }
}

export class ReservationAlreadyCancelledError extends DomainError {
  readonly statusCode = 409;
  readonly code = 'ALREADY_CANCELLED';
  constructor(reservationId: string) {
    super('Reservation is already cancelled', { reservation_id: reservationId });
  }
}

export class ServiceUnavailableError extends DomainError {
  readonly statusCode = 503;
  readonly code = 'SERVICE_UNAVAILABLE';
}
