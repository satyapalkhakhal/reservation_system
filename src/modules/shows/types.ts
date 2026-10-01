export type SeatStatus = 'available' | 'held' | 'confirmed';

export interface Show {
  id: string;
  name: string;
  price_paise: number;
  per_user_limit: number;
  created_at: Date;
}

export interface SeatState {
  seat: string;
  status: SeatStatus;
}

export interface ShowState {
  id: string;
  name: string;
  price_paise: number;
  per_user_limit: number;
  created_at: string;
  total_seats: number;
  counts: Record<SeatStatus, number>;
  seats: SeatState[];
}
