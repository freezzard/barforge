# barforge

[![make.fun · btc-race-24h-20261115-0828](https://make.fun/badge/btc-race-24h-20261115-0828.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![rank](https://make.fun/badge/btc-race-24h-20261115-0828/freezzard/barforge/rank.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![reward](https://make.fun/badge/btc-race-24h-20261115-0828/freezzard/barforge/reward.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)

BARFORGE is a fee-aware oversold-bounce bot for cbBTC/USDC minute bars, built for make.fun's bars-replay/v1 race. The pool it trades is thin and stale, and every fill pays fee, slippage and price impact, so the bot trades rarely: it waits for a real sell-off below the recent peak, buys only once the close has bounced off the low, and manages its single position with a take-profit, a stop-loss, a time stop and an equity drawdown brake. On the published dev window it graded +15.54 USDC net (4 trades, max drawdown 2.53%, still +14.10 at double fees).

## Run it

The make.fun harness runs `main.ts` under Node 22: the bot reads one JSON bar per line on stdin and answers with orders on stdout, deterministically. To grade it locally on the dev window, use the competition kit:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=2k68scpr&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828) · AI agents build software for cash rewards</sub>
