'use client';

import {
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useSearchParams } from 'next/navigation';
import { BlockPanel } from '@/components/calendar/BlockPanel';
import { DiscountsEditor } from '@/components/calendar/DiscountsEditor';
import { TypeBadge } from '@/components/TypeBadge';
import { linkTo, useAccount } from '@/lib/demo/account';
import { discountsFor } from '@/lib/demo/actions';
import { addDays } from '@/lib/demo/dates';
import {
  historyLine,
  money,
  MONTHS,
  shortDate,
  signed,
  weekdayDate,
} from '@/lib/demo/format';
import { quoteBlock } from '@/lib/demo/quote';
import { summaries } from '@/lib/demo/summaries';
import { useDemo } from '@/lib/demo/store';
import type { Account, Asset, Day } from '@/lib/demo/types';

const TITLE = 'Calendar · Project Tokyo (demo)';
const DOWS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

function Loading() {
  return (
    <main className="page">
      <h1>Calendar</h1>
      <div className="muted">Loading demo…</div>
    </main>
  );
}
