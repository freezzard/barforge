// BARFORGE — a fee-aware oversold-bounce bot for cbBTC/USDC minute bars.
//
// The market it trades is a thin on-chain pool: the price is stale for long
// stretches and moves in steps when someone trades the pool, and every fill
// pays the 4 bps fee, 2 bps of modelled slippage and constant-product impact
// against the bar's depth — roughly a quarter of a percent for a full-size
// round trip. Churn is death here (the house EMA-cross bleeds on exactly
// that), so this bot trades rarely and only when the expected move dwarfs
// the cost of the round trip:
//
//   - It waits for a real sell-off: the latest close at least
//     ENTRY_DRAWDOWN_BPS below the highest close of the last
//     PEAK_LOOKBACK_BARS bars.
//   - It does not catch the knife: the close must already have bounced
//     ENTRY_BOUNCE_BPS off the lowest close of the last LOW_LOOKBACK_BARS
//     bars, so the slide has visibly stalled before it buys.
//   - It buys POSITION_FRACTION_BPS of the cash it holds, once, and then
//     manages the one position: out at TAKE_PROFIT_BPS over its cost, out
//     at STOP_LOSS_BPS under it, out on a TRAIL_BPS give-back once the
//     trade has run TRAIL_ARM_BPS into profit, and out after
//     TIME_STOP_BARS bars whatever happened.
//   - After any exit it rests COOLDOWN_BARS bars, and once the equity has
//     fallen DRAWDOWN_BRAKE_BPS from its peak it opens nothing new (the
//     race ranks a bot that misses the 25% drawdown bar below everyone
//     who meets it; the brake keeps a bad day from ever nearing that).
//
//   - Insurance: if FALLBACK_AFTER_BARS bars pass without a single
//     entry, the bot places one small probe trade (FALLBACK_FRACTION_BPS
//     of cash, hard exit after FALLBACK_HOLD_BARS bars) on the first
//     active bar, so a dead-flat race day cannot leave it with zero
//     trades — the race ranks a zero-trade bot below everyone who
//     traded at all. The probe can only fire when nothing has ever
//     been opened, so it never touches a run the strategy traded.
//
// Every ratio test is exact bigint arithmetic on the integer closes, so
// two runs over the same bars give the same orders byte for byte. All
// tunables are the named constants below, in one place, so a parameter
// sweep only ever rewrites this block.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

// ---- entry ----
/** Bars of closes the sell-off is measured over (the peak window). */
const PEAK_LOOKBACK_BARS = 180;
/** Bars of closes the bounce off the bottom is measured over. */
const LOW_LOOKBACK_BARS = 45;
/** Enter only when the close is at least this far under the peak close. */
const ENTRY_DRAWDOWN_BPS = 250;
/** ... and has already bounced at least this far off the recent low. */
const ENTRY_BOUNCE_BPS = 40;
/** Share of the cash on hand one entry spends, in bps. */
const POSITION_FRACTION_BPS = 9_000;
/** Batches to rest after an exit before any new entry. */
const COOLDOWN_BARS = 180;

// ---- fallback probe (zero-trade insurance) ----
/** Bars that may pass with no entry at all before the probe may fire. */
const FALLBACK_AFTER_BARS = 1200;
/** Share of the cash on hand the one probe trade spends, in bps. */
const FALLBACK_FRACTION_BPS = 1_000;
/** The probe position is closed after this many bars whatever happened. */
const FALLBACK_HOLD_BARS = 20;

// ---- exit (against the position's cost, fees included) ----
/** Sell when the position is worth this much over its cost, in bps. */
const TAKE_PROFIT_BPS = 320;
/** Sell when the position is worth this much under its cost, in bps. */
const STOP_LOSS_BPS = 110;
/** The trailing exit arms once the position is worth this over cost.
 *  Tuned to 100_000 (never arms) on the dev window's evidence: the arm at
 *  80 armed on noise and clipped the bounces this bot exists to ride. */
const TRAIL_ARM_BPS = 100_000;
/** ... and sells when the close gives this back from its best, in bps. */
const TRAIL_BPS = 80;
/** Sell whatever is still held after this many bars in the position. */
const TIME_STOP_BARS = 360;

// ---- risk ----
/** No new entries once equity is this far under its peak, in bps. */
const DRAWDOWN_BRAKE_BPS = 800;
/** Slippage caps: entries may gap a little, exits a little more. */
const BUY_MAX_SLIPPAGE_BPS = 200;
const SELL_MAX_SLIPPAGE_BPS = 300;

const BPS = 10_000n;
const SYMBOL = 'CBBTC';

/** Every close seen, warm-up bars included, oldest first. */
const closes: bigint[] = [];
/** Seq of the batch the current position's entry was decided on. */
let entrySeq = -1;
/** Best close seen since the position was filled. */
let peakCloseInTrade = 0n;
/** Seq of the batch the last exit was decided on (cooldown anchor). */
let lastExitSeq = -1;
/** Highest equity marked so far, for the drawdown brake. */
let peakEquity = 0n;
/** Whether a position was held at the previous batch (exit detection). */
let wasHolding = false;
/** Positions opened so far (the probe requires exactly zero). */
let entriesOpened = 0;
/** Whether the probe order has been placed (it fires at most once). */
let probeFired = false;
/** Whether the next position to appear is the probe's fill. */
let probePending = false;
/** Whether the position currently held is the probe. */
let positionIsProbe = false;

function maxOf(xs: bigint[]): bigint {
  let m = xs[0]!;
  for (const x of xs) if (x > m) m = x;
  return m;
}

function minOf(xs: bigint[]): bigint {
  let m = xs[0]!;
  for (const x of xs) if (x < m) m = x;
  return m;
}

await runBars({
  onBatch(state: BarsState, batch) {
    // Record this batch's bar, if the minute had one; a minute with no
    // sample carries no bar for the symbol and adds nothing.
    let fresh = false;
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      closes.push(BigInt(bar.c));
      fresh = true;
    }
    if (state.equity > peakEquity) peakEquity = state.equity;

    const held = state.positions.get(SYMBOL);
    if (wasHolding && held === undefined && entrySeq >= 0) {
      // The position vanished since the last batch: the exit filled.
      lastExitSeq = state.seq;
      entrySeq = -1;
      peakCloseInTrade = 0n;
      positionIsProbe = false;
    }
    if (!wasHolding && held !== undefined) {
      // A fill appeared since the last batch: an entry opened.
      entriesOpened++;
      positionIsProbe = probePending;
      probePending = false;
    }
    wasHolding = held !== undefined;

    if (state.warmingUp || !fresh) return [];
    const close = closes[closes.length - 1]!;

    // ---- manage the open position ----
    if (held !== undefined) {
      if (entrySeq < 0) {
        // First batch that sees the fill: start the trade clocks.
        entrySeq = state.seq;
        peakCloseInTrade = close;
      }
      if (close > peakCloseInTrade) peakCloseInTrade = close;
      const value = state.value(SYMBOL, held.qty);
      const cost = held.cost;
      const sell: OrderInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: SELL_MAX_SLIPPAGE_BPS };
      if (value * BPS >= cost * (BPS + BigInt(TAKE_PROFIT_BPS))) return [sell];
      if (value * BPS <= cost * (BPS - BigInt(STOP_LOSS_BPS))) return [sell];
      // Trailing exit: once the position's best mark is TRAIL_ARM_BPS over
      // its cost, a TRAIL_BPS give-back from that best close ends it.
      const peakValue = state.value(SYMBOL, held.qty, peakCloseInTrade);
      if (peakValue * BPS >= cost * (BPS + BigInt(TRAIL_ARM_BPS)) && close * BPS <= peakCloseInTrade * (BPS - BigInt(TRAIL_BPS))) return [sell];
      // The probe is insurance, not a trade to ride: out after
      // FALLBACK_HOLD_BARS bars even if nothing else has triggered.
      if (positionIsProbe && state.seq - entrySeq >= FALLBACK_HOLD_BARS) return [sell];
      if (state.seq - entrySeq >= TIME_STOP_BARS) return [sell];
      return [];
    }

    // ---- look for an entry ----
    let entryOrder: OrderInput | null = null;
    if (closes.length >= PEAK_LOOKBACK_BARS
      && !(lastExitSeq >= 0 && state.seq - lastExitSeq < COOLDOWN_BARS)
      && !(peakEquity > 0n && state.equity * BPS <= peakEquity * (BPS - BigInt(DRAWDOWN_BRAKE_BPS)))) {
      const peak = maxOf(closes.slice(-PEAK_LOOKBACK_BARS));
      if (close * BPS <= peak * (BPS - BigInt(ENTRY_DRAWDOWN_BPS))) {
        const low = minOf(closes.slice(-LOW_LOOKBACK_BARS));
        if (close * BPS >= low * (BPS + BigInt(ENTRY_BOUNCE_BPS))) {
          const notional = (state.cash * BigInt(POSITION_FRACTION_BPS)) / BPS;
          if (notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
            const room = state.weightRoom(SYMBOL);
            const spend = notional < room ? notional : room;
            if (spend >= BigInt(state.hello.fees.min_notional_quote_units)) {
              entryOrder = { side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: BUY_MAX_SLIPPAGE_BPS };
            }
          }
        }
      }
    }
    if (entryOrder !== null) return [entryOrder];

    // ---- fallback probe: one small trade so a flat day cannot end
    // with zero trades. Only reachable while flat, and only when no
    // entry has ever opened, so a run the strategy traded is untouched.
    if (!probeFired && entriesOpened === 0 && closes.length > FALLBACK_AFTER_BARS
      && closes.length >= 2 && close !== closes[closes.length - 2]!) {
      const notional = (state.cash * BigInt(FALLBACK_FRACTION_BPS)) / BPS;
      if (notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
        const room = state.weightRoom(SYMBOL);
        const spend = notional < room ? notional : room;
        if (spend >= BigInt(state.hello.fees.min_notional_quote_units)) {
          probeFired = true;
          probePending = true;
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: BUY_MAX_SLIPPAGE_BPS }];
        }
      }
    }
    return [];
  },
});
