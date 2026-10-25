# Trading games

Two live multiplayer classroom games for teaching how markets work. Each is a self-contained Node + React app with its own README, tests and Railway service; both share one Railway Postgres.

| Game | Folder | Live | What it teaches |
|---|---|---|---|
| Dice Market | [`dice-market/`](dice-market/) | https://web-production-3b3d3.up.railway.app | Bids, asks, private valuations, short selling and squeeze risk |
| Fair Cards | [`fair-cards/`](fair-cards/) | https://fair-cards-production.up.railway.app | Market making: two-sided quoting, price discovery, adverse selection, news shocks, informed flow |

Both end each round with a per-player decision review that values every decision in expected coins and says what would have been better.

```bash
cd dice-market && npm install && npm test
cd fair-cards && npm install && npm test
```

Deploy from the repo root:

```bash
npx -y @railway/cli up ./dice-market --path-as-root --service web
npx -y @railway/cli up ./fair-cards --path-as-root --service fair-cards
```
