# Run the demo

One command runs the whole story on Solana devnet with real transactions: an owner funds an agent, the agent buys data with Blindfold tokens, a replay is refused, the provider is paid in USDC, the agent refuses a dishonest mint, the same purchases run over standard x402 `exact`, and a competitor bot shows what each method leaks onchain.

Commands work in fish, bash and zsh. Run them from the repository root.

## Before the first run

1. **Build** (after every `git pull`):
   ```sh
   npx -y pnpm@10.33.0 install --frozen-lockfile
   npx -y pnpm@10.33.0 -r build
   ```
2. **Keys.** The demo reads `.keys/` (gitignored). It needs `deployer.json`, `owner.json`, `mint-authority.json`, `provider-payout.json` and `provider-secret.hex`, and creates `exact-agent.json` and `facilitator.json` on first run. If `.keys/` is missing, restore it from your backup: each `== name` line in the backup file is followed by that file's contents.
3. **A private RPC (recommended).** The public devnet RPC allows about 10 requests per method in a short window. The demo retries through that, but a free devnet endpoint from Helius or QuickNode makes the run faster and smoother:
   ```sh
   set -x SOLANA_RPC_URL https://devnet.helius-rpc.com/?api-key=YOUR_KEY   # fish
   export SOLANA_RPC_URL=https://devnet.helius-rpc.com/?api-key=YOUR_KEY   # bash/zsh
   ```
4. **PostgreSQL** starts automatically through `services/mint/scripts/dev-pg.sh` unless `DATABASE_URL` is set. Each run uses a throwaway schema.

## Run it

```sh
npx -y pnpm@10.33.0 demo
```

The demo pauses before each act; press Enter to continue. It ends with Solana Explorer links for every transaction.

| Option | Effect |
|---|---|
| `--no-pause` | Run straight through |
| `--calls N` | Paid calls per payment method (default 3) |
| `--localnet` | Rehearsal on a throwaway local validator with fresh keys; needs `anchor build` and the Solana tools, spends no devnet funds |

A run takes a few minutes, longer on the public RPC. Each run deposits $1.00 of devnet USDC (most of it stays in the vault backing the agent's unspent tokens), pays $0.15 through `exact` and spends about 0.01 SOL in fees. Before the run it tops up the facilitator's SOL from the deployer and the `exact` agent's USDC from the owner when they run low.

### Second terminal: the live competitor bot

For a split-screen recording, run the bot next to the demo. It watches the provider's payout account and the vault using only public RPC data, and prints each transaction as it appears:

```sh
npx -y pnpm@10.33.0 bot
```

`--once` prints what is already visible and exits.

## What each act shows

| Act | On screen | What to say |
|---|---|---|
| Setup | Who is involved; vault Explorer link | "The agent has no Solana key, only a file of tokens." |
| 1. Fund | $1.00 deposit, 40 tokens, Explorer link | "USDC goes into a vault; the mint signs tokens blind, so it can't link them to later purchases." |
| 2. Buy | Reserve check, 3 paid calls with data | "Before paying, the agent checks the vault on Solana. Each payment is a token in an HTTP header: no transaction." |
| 3. Replay | Replayed call refused with 402 | "A copied payment buys nothing; tokens are spent on first use." |
| 4. Settle | One batch payout, Explorer link, balanced books | "The provider gets paid in USDC in one batch that covers many calls." |
| 5. Reserve gate | Agent stops with exit code 7 | "If the mint claims more liabilities than the vault holds, the agent pays nothing." |
| 6. `exact` | Same endpoint, 3 standard x402 payments, 3 Explorer links | "Standard x402: the agent needs a funded wallet and every call is a public transfer." |
| 7. Competitor | Payer wallet, call count and timing for `exact`; only a deposit and one payout for Blindfold | "Same purchases. One leaks who, what and when. The other shows money in and money out." |

State the limit honestly: with few users, or distinctive amounts and timing, deposits and payouts can still be correlated.

## Recording tips

- Use a terminal at least 100 columns wide with a large font.
- Do one run before recording, so dependencies are warm and balances are topped up.
- Keep the Explorer tabs from the final summary open for the walkthrough.
- Record a backup run as soon as one passes.

## Troubleshooting

| Message | Fix |
|---|---|
| `missing .keys/...` | Restore `.keys/` from your backup |
| `owner ... needs at least 2 devnet USDC` | faucet.circle.com, Solana, Devnet, to the owner address shown |
| `needs devnet SOL and the deployer cannot cover it` | faucet.solana.com to the deployer address in `docs/design/01-vault.md` |
| `RPC busy (rate limited); retrying` | Expected on the public RPC; set `SOLANA_RPC_URL` to a private endpoint |
| `no active vault provider uses .keys/provider-secret.hex` | Wrong key folder, or provider 0 was deactivated; see `docs/design/01-vault.md` |
| Port 3338 or 4000 busy | The demo picks free ports automatically and prints them |
| `a validator is already running` (`--localnet`) | Stop the other `solana-test-validator` |

For the step-by-step services and the acceptance test, see [Run it locally](RUNNING.md).
