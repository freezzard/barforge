// BARFORGE — an active-bar Donchian trend bot for cbBTC/USDC minute bars.
//
// This pool is stale: its price moves only when someone trades it, so most
// one-minute bars are flat and any indicator averaged over raw minutes is
// mostly averaging a frozen price. Every indicator here therefore runs on
// ACTIVE bars only — bars whose close differs from the previous close.
// Flat bars update nothing.
//
// The bot is a breakout trend follower with cost discipline:
//   - Entry (decided on an active bar, filled at the next bar's open):
//     the close breaks the highest high of the last DONCHIAN_K active
//     bars, EMA_fast sits above EMA_slow on active closes, and the close
//     already stands MIN_RANGE_BPS off the channel's low — a move smaller
//     than that cannot pay the round trip (the 4 bps fee and 2 bps
//     slippage each way, plus impact), which the entry also estimates
//     from the live depth and refuses when it exceeds MAX_COST_BPS.
//   - Size: TARGET_FRACTION_BPS of equity, never more than
//     DEPTH_CAP_BPS of the pool's depth at the latest close, so an order
//     stays a small share of the pool it moves.
//   - Exit: a trailing stop TRAIL_MULT active-bar ATRs under the best
//     close since entry, or the close back under EMA_slow. After an exit
//     the bot rests COOLDOWN_BARS batches.
//   - Hard guard: an equity drawdown of DD_GUARD_BPS from its peak exits
//     everything and locks entries for the rest of the window (the race
//     ranks a bot over the 25% drawdown bar below everyone under it).
//   - Guaranteed trade: if no position has ever been filled by batch
//     FALLBACK_START_SEQ, the bot buys FALLBACK_FRACTION_BPS of equity on
//     the next active bar with a healthy cost estimate and sells it
//     FALLBACK_HOLD_BARS batches later — the race bar needs a trade, and
//     a bot that never found its signal still owes one.
//
// Indicator math is float64 on + - * / alone (each correctly rounded, as
// the house baselines rely on), so two runs over the same bars answer
// byte for byte. All tunables are the named constants below, one per
// line, so a parameter sweep only ever rewrites this block.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

// ---- the strategy's constants (sweep only ever rewrites this block) ----
/** Active bars in the Donchian channel. */
const DONCHIAN_K = 12;
/** EMA spans on active closes. */
const EMA_FAST_SPAN = 5;
const EMA_SLOW_SPAN = 15;
/** Wilder ATR period on active bars. */
const ATR_PERIOD = 14;
/** The close must stand at least this far off the channel low, in bps. */
const MIN_RANGE_BPS = 45;
/** Entries are refused when the estimated round trip costs more, in bps. */
const MAX_COST_BPS = 22;
/** Trailing stop distance, in active-bar ATRs under the best close. */
const TRAIL_MULT = 2.5;
/** Share of equity one entry targets, in bps. */
const TARGET_FRACTION_BPS = 8_500;
/** An order may not exceed this share of the pool depth, in bps. */
const DEPTH_CAP_BPS = 600;
/** Batches to rest after an exit before any new entry. */
const COOLDOWN_BARS = 5;
/** Equity drawdown from peak that exits all and locks entries, in bps. */
const DD_GUARD_BPS = 1_800;
/** Batch from which the guaranteed-trade fallback may fire. */
const FALLBACK_START_SEQ = 1_200;
/** Share of equity the fallback buys, in bps. */
const FALLBACK_FRACTION_BPS = 1_000;
/** Batches the fallback holds before selling. */
const FALLBACK_HOLD_BARS = 20;
/** Slippage caps: entries may gap a little, exits a little more. */
const BUY_MAX_SLIPPAGE_BPS = 200;
const SELL_MAX_SLIPPAGE_BPS = 300;

const BPS = 10_000n;
const SYMBOL = 'CBBTC';

// ---- active-bar series and indicators ----
/** Previous bar's close (any bar), to tell whether a bar is active. */
let prevClose: bigint | null = null;
const aHigh: number[] = [];
const aLow: number[] = [];
const aClose: number[] = [];

interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}
const emaFast: Ema = { span: EMA_FAST_SPAN, warm: [], value: null };
const emaSlow: Ema = { span: EMA_SLOW_SPAN, warm: [], value: null };

function stepEma(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

/** Wilder ATR over active bars: seeded by the mean of its first TRs. */
let atrWarm: number[] = [];
let atrValue: number | null = null;
let prevActiveClose: number | null = null;

function stepAtr(high: number, low: number, close: number): void {
  if (prevActiveClose === null) {
    prevActiveClose = close;
    return;
  }
  const tr = Math.max(high - low, Math.abs(high - prevActiveClose), Math.abs(low - prevActiveClose));
  prevActiveClose = close;
  if (atrValue !== null) {
    atrValue = (atrValue * (ATR_PERIOD - 1) + tr) / ATR_PERIOD;
    return;
  }
  atrWarm.push(tr);
  if (atrWarm.length === ATR_PERIOD) {
    atrValue = atrWarm.reduce((a, x) => a + x, 0) / ATR_PERIOD;
    atrWarm = [];
  }
}

// ---- run state ----
/** Seq of the batch the current position was first seen on. */
let entrySeq = -1;
/** Best close since the position was first seen (raw price units). */
let peakCloseInTrade = 0;
/** Seq of the batch the last exit filled on (cooldown anchor). */
let lastExitSeq = -1;
/** Whether any position has ever been filled (the fallback's trigger). */
let everHeld = false;
/** Whether the position now held is the fallback's. */
let inFallback = false;
/** A fallback buy has been sent but not yet seen filled. */
let fallbackSent = false;
/** Highest equity marked so far, and the drawdown guard's lock. */
let peakEquity = 0n;
let ddLocked = false;
/** Whether a position was held at the previous batch (exit detection). */
let wasHolding = false;

/** The estimated round-trip cost, in bps, of a trade of `size` quote units at the latest depth. */
function roundTripBps(state: BarsState, size: bigint): number | null {
  const impact = state.impactBps(SYMBOL, size);
  if (impact === null) return null;
  const { fee_bps, slippage_bps } = state.hello.fees;
  return 2 * (fee_bps + slippage_bps) + 2 * Number(impact);
}

/** The buy size the caps allow for a target fraction of equity, in quote units. */
function buySize(state: BarsState, fractionBps: number): bigint {
  let size = (state.equity * BigInt(fractionBps)) / BPS;
  const depth = state.depthAt(SYMBOL);
  if (depth !== null && depth.length > 0) {
    const cap = (depth[0]! * BigInt(DEPTH_CAP_BPS)) / BPS;
    if (cap < size) size = cap;
  }
  if (state.cash < size) size = state.cash;
  const room = state.weightRoom(SYMBOL);
  if (room < size) size = room;
  return size;
}

await runBars({
  onBatch(state: BarsState, batch) {
    // Fold this batch's bar (a minute with no sample carries none).
    let fresh = false;
    let active = false;
    let close = 0;
    let high = 0;
    let low = 0;
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      fresh = true;
      const c = BigInt(bar.c);
      active = prevClose === null || c !== prevClose;
      prevClose = c;
      close = Number(bar.c);
      high = Number(bar.h);
      low = Number(bar.l);
    }
    if (state.equity > peakEquity) peakEquity = state.equity;

    const held = state.positions.get(SYMBOL);
    if (held !== undefined) everHeld = true;
    if (wasHolding && held === undefined && entrySeq >= 0) {
      lastExitSeq = state.seq;
      entrySeq = -1;
      peakCloseInTrade = 0;
      inFallback = false;
    }
    wasHolding = held !== undefined;

    // The drawdown guard reads equity, which every batch marks.
    if (!ddLocked && peakEquity > 0n && state.equity * BPS <= peakEquity * (BPS - BigInt(DD_GUARD_BPS))) ddLocked = true;

    if (state.warmingUp || !fresh) return [];

    // Indicators move on active bars alone; the channel is read from the
    // active bars before this one, the EMAs and ATR after folding it in.
    let channelHigh = 0;
    let channelLow = 0;
    if (active) {
      if (aHigh.length >= DONCHIAN_K) {
        channelHigh = Math.max(...aHigh.slice(-DONCHIAN_K));
        channelLow = Math.min(...aLow.slice(-DONCHIAN_K));
      }
      aHigh.push(high);
      aLow.push(low);
      aClose.push(close);
      stepEma(emaFast, close);
      stepEma(emaSlow, close);
      stepAtr(high, low, close);
    }

    const sellAll = (): OrderInput[] =>
      held === undefined ? [] : [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: SELL_MAX_SLIPPAGE_BPS }];

    // ---- the hard guard outranks every other rule ----
    if (ddLocked) return held === undefined ? [] : sellAll();

    // ---- manage the open position ----
    if (held !== undefined) {
      if (entrySeq < 0) {
        entrySeq = state.seq;
        peakCloseInTrade = close;
        if (fallbackSent) {
          inFallback = true;
          fallbackSent = false;
        }
      }
      if (close > peakCloseInTrade) peakCloseInTrade = close;
      if (inFallback) {
        if (state.seq - entrySeq >= FALLBACK_HOLD_BARS) return sellAll();
        return [];
      }
      if (atrValue !== null && close < peakCloseInTrade - TRAIL_MULT * atrValue) return sellAll();
      if (emaSlow.value !== null && close < emaSlow.value) return sellAll();
      return [];
    }

    // ---- entries are decided on active bars ----
    if (!active) return [];
    if (lastExitSeq >= 0 && state.seq - lastExitSeq < COOLDOWN_BARS) return [];

    // The strategy's breakout entry.
    if (
      channelHigh > 0 &&
      close > channelHigh &&
      emaFast.value !== null &&
      emaSlow.value !== null &&
      emaFast.value > emaSlow.value &&
      (close - channelLow) * 10_000 >= channelLow * MIN_RANGE_BPS
    ) {
      const size = buySize(state, TARGET_FRACTION_BPS);
      if (size >= BigInt(state.hello.fees.min_notional_quote_units)) {
        const cost = roundTripBps(state, size);
        if (cost !== null && cost <= MAX_COST_BPS) {
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: BUY_MAX_SLIPPAGE_BPS }];
        }
      }
      return [];
    }

    // The guaranteed-trade fallback: no fill yet, late in the window.
    if (!everHeld && state.seq >= FALLBACK_START_SEQ) {
      const size = buySize(state, FALLBACK_FRACTION_BPS);
      if (size >= BigInt(state.hello.fees.min_notional_quote_units)) {
        const cost = roundTripBps(state, size);
        if (cost !== null && cost <= MAX_COST_BPS) {
          fallbackSent = true;
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: BUY_MAX_SLIPPAGE_BPS }];
        }
      }
    }
    return [];
  },
});
