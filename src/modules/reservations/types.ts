export type ReservationStatus = 'confirmed' | 'cancelled';

export interface Reservation {
  id: string;
  show_id: string;
  user_id: string;
  status: ReservationStatus;
  seat_count: number;
  amount_paise: number;
  created_at: Date;
  cancelled_at: Date | null;
}

export interface LockedSeat {
  id: string;
  seat_number: string;
  status: 'available' | 'held' | 'confirmed';
}

/** Public API representation. */
export interface ReservationView {
  reservation_id: string;
  show_id: string;
  user_id: string;
  seats: string[];
  amount_paise: number;
  status: ReservationStatus;
  created_at: string;
  cancelled_at: string | null;
}
