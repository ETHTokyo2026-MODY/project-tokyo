export type AssetType = 'car' | 'airbnb' | 'hotel room';

export type Account = {
  name: string;
  role: string;
  cash: number;
  startCash: number;
};

/** Nights → percent off. Legacy saves use keys 3/7/14/21/30. */
export type Discounts = Record<number, number>;

export type CurvePoint = {
  date: string;
  price: number;
};

export type Curve = {
  min: number;
  points: CurvePoint[];
  past?: CurvePoint[];
};

export type HistoryEntry =
  | {
      type: 'trade';
      from: string;
      to: string;
      price: number;
      block?: number;
      at: string;
    }
  | { type: 'payout'; to: string; price: number; at: string }
  | { type: 'booking'; price: number; at: string; simulated: true }
  | { type: 'unbook'; price: number; at: string };

export type DayStatus = 'open' | 'booked' | 'unbooked';

export type Day = {
  date: string;
  weekday: number;
  base: number;
  status: DayStatus;
  owner: string;
  price: number;
  predicted?: number;
  listed: boolean;
  salePrice?: number;
  history: HistoryEntry[];
  settled?: boolean;
  curve?: Curve;
};

export type CustomAssetSpec = {
  /** 7 weekday prices, Sun..Sat */
  base: number[];
  min: number;
  seed: number;
  createdAt: string;
};

export type Asset = {
  id: string;
  type: AssetType;
  title: string;
  provider: string;
  location: string;
  discounts: Record<string, Discounts>;
  days: Day[];
  custom?: CustomAssetSpec;
};

export type BidSnap = { owner: string; status: DayStatus };

export type Bid = {
  id: string;
  asset: string;
  buyer: string;
  from: string;
  to: string;
  limit: number;
  snap: Record<string, BidSnap>;
};

export type DemoState = {
  seededOn: string;
  curveDay: string;
  version: number;
  accounts: Record<string, Account>;
  assets: Asset[];
  /** Open limit bids. Missing on old localStorage saves. */
  bids?: Bid[];
};
