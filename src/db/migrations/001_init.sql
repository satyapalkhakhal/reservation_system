-- 001_init: core schema for seat reservations.
-- Every invariant that matters for correctness is enforced here, not only in
-- application code. The app's locking protocol makes violations impossible in
-- practice; these constraints turn any bug into a loud error instead of
-- silently corrupt data.

CREATE TABLE shows (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text        NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- Money is always integer minor units (paise). Never floating point.
  price_paise     bigint      NOT NULL CHECK (price_paise >= 0),
  per_user_limit  integer     NOT NULL CHECK (per_user_limit > 0),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reservations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id       uuid        NOT NULL REFERENCES shows(id),
  -- Comes from the authenticated token, never from a request body.
  user_id       text        NOT NULL CHECK (length(user_id) BETWEEN 1 AND 255),
  status        text        NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  seat_count    integer     NOT NULL CHECK (seat_count > 0),
  amount_paise  bigint      NOT NULL CHECK (amount_paise >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  cancelled_at  timestamptz NULL,
  -- A reservation is cancelled iff it has a cancellation timestamp.
  CONSTRAINT reservations_cancelled_at_consistent
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE INDEX reservations_user_show_idx ON reservations (user_id, show_id);

CREATE TABLE show_seats (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id         uuid        NOT NULL REFERENCES shows(id),
  -- COLLATE "C": byte-order comparison, so ORDER BY seat_number (our lock
  -- order) is identical on every machine regardless of OS locale.
  seat_number     text COLLATE "C" NOT NULL CHECK (length(seat_number) BETWEEN 1 AND 32),
  status          text        NOT NULL DEFAULT 'available'
                    CHECK (status IN ('available', 'held', 'confirmed')),
  reservation_id  uuid        NULL REFERENCES reservations(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- A show cannot contain the same seat twice.
  CONSTRAINT show_seats_show_seat_unique UNIQUE (show_id, seat_number),
  -- An available seat has no owner; a held/confirmed seat always has one.
  CONSTRAINT show_seats_owner_matches_status
    CHECK ((status = 'available') = (reservation_id IS NULL))
);
-- Counts per status (show state, metrics).
CREATE INDEX show_seats_show_status_idx ON show_seats (show_id, status);
-- Cancellation releases seats by reservation_id.
CREATE INDEX show_seats_reservation_idx ON show_seats (reservation_id) WHERE reservation_id IS NOT NULL;

CREATE TABLE reservation_seats (
  reservation_id uuid    NOT NULL REFERENCES reservations(id),
  seat_id        uuid    NOT NULL REFERENCES show_seats(id),
  -- false once the reservation is cancelled (history is kept).
  active         boolean NOT NULL DEFAULT true,
  -- A reservation lists each seat at most once.
  PRIMARY KEY (reservation_id, seat_id)
);
-- SAFETY NET: a seat can belong to at most ONE active reservation.
-- Even if application locking were broken, PostgreSQL rejects a double sale.
CREATE UNIQUE INDEX reservation_seats_one_active_owner
  ON reservation_seats (seat_id) WHERE active;

-- One row per (user, show). Its row lock is the serialization point for all of
-- a user's reservation/cancellation transactions on a show, and its counter is
-- what the per-user limit is checked against.
CREATE TABLE user_show_quotas (
  user_id         text    NOT NULL,
  show_id         uuid    NOT NULL REFERENCES shows(id),
  seats_reserved  integer NOT NULL DEFAULT 0 CHECK (seats_reserved >= 0),
  PRIMARY KEY (user_id, show_id)
);

CREATE TABLE idempotency_keys (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          text        NOT NULL,
  show_id          uuid        NOT NULL REFERENCES shows(id),
  idempotency_key  text        NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  -- sha256 of the normalized request (see reservations/hash.ts).
  request_hash     text        NOT NULL,
  reservation_id   uuid        NOT NULL REFERENCES reservations(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- A key identifies at most one reservation per user per show. Keys are
  -- scoped per user so one user can never collide with (or replay) another's.
  CONSTRAINT idempotency_keys_scope_unique UNIQUE (user_id, show_id, idempotency_key)
);
