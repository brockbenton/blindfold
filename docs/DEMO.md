# Run the demo

One command runs **Copycat vs. your trading agent** on Solana devnet with real transactions. Your agent researches SOL by buying whale-flow data from TokenFeed, a mock token data feed. First it pays with standard x402 `exact`, and Copycat, a front-running bot that reads only public Solana data, turns those payments into "BUY SOL". Then the owner funds Blindfold tokens and the agent does the same research, plus a few reads from NewsWire, a second registered feed. Copycat sees a deposit and, at the next fixed settlement window, one batch paying both feeds rounded amounts, and reports no signal. Three safety acts follow: an AI agent reads a feed response carrying a prompt injection that points it at an attacker, its tokens cannot pay the attacker, and a 25-cent purchase waits for the owner's approval; a replayed payment is refused; and the agent refuses a mint that lies about its reserves. A local dashboard shows both sides live.

Commands work in fish, bash and zsh. Run them from the repository root.

## Before the first run

1. **Build** (after every `git pull`):
   ```sh
   npx -y pnpm@10.33.0 install --frozen-lockfile
   npx -y pnpm@10.33.0 -r build
   ```
2. **Keys.** The demo reads `.keys/` (gitignored). It needs `deployer.json`, `owner.json`, `mint-authority.json`, `provider-payout.json` and `provider-secret.hex`, and creates `exact-agent.json`, `facilitator.json`, `news-payout.json` and `news-secret.hex` on first run. The first run also registers NewsWire with the vault, signed by the deployer (the vault admin). Add the created files to your key backup; losing them strands NewsWire's registration, and the next run registers a new one. If `.keys/` is missing, restore it from your backup: each `== name` line in the backup file is followed by that file's contents.
3. **An LLM key (optional, for Act 6).** Save a Gemini API key (free tier at aistudio.google.com) to `.keys/llm.key`, or set `LLM_API_KEY`. `LLM_BASE_URL` and `LLM_MODEL` switch to any OpenAI-compatible provider. Without a key, Act 6 skips the model and shows only the refused hijack attempt.
4. **A private RPC (recommended).** The public devnet RPC allows about 10 requests per method in a short window. The demo retries through that, but a free devnet endpoint from Helius or QuickNode makes the run faster and smoother:
   ```sh
   set -x SOLANA_RPC_URL https://devnet.helius-rpc.com/?api-key=YOUR_KEY   # fish
   export SOLANA_RPC_URL=https://devnet.helius-rpc.com/?api-key=YOUR_KEY   # bash/zsh
   ```
5. **PostgreSQL** starts automatically through `services/mint/scripts/dev-pg.sh` unless `DATABASE_URL` is set. Each run uses a throwaway schema.
6. **QuickNode Streams (optional, recommended).** Copycat reads new transactions from a QuickNode Stream. Without one it polls RPC. See [QuickNode Streams](#quicknode-streams-optional).

## QuickNode Streams (optional)

With a QuickNode API key, Copycat gets transactions pushed by a Stream instead of polling RPC. The [README](../README.md#quicknode-streams) explains the configuration. The free trial plan is enough.

1. **API key.** In the QuickNode dashboard, open the avatar menu, then **API Keys**, and create a key with Streams access. Save it (gitignored, never commit it), then back up the file like the other keys:
   ```sh
   printf '{"apiKey":"YOUR_KEY"}\n' > .keys/quicknode.json; chmod 600 .keys/quicknode.json
   ```
   `QUICKNODE_API_KEY` works too.
2. **cloudflared**, for a free public HTTPS URL to the local webhook (no Cloudflare account needed): `sudo pacman -S cloudflared`, `brew install cloudflared`, or download the single binary from Cloudflare's [releases](https://github.com/cloudflare/cloudflared/releases) into `~/.local/bin`. To use your own tunnel instead, set `STREAMS_WEBHOOK_URL` to its public URL and `STREAMS_PORT` to the local port it forwards to (`pnpm bot` only).
3. **Create the Stream** and check the filter on a known devnet block:
   ```sh
   npx -y pnpm@10.33.0 streams:setup --test 522985052
   ```
   The result should show one record with memo `whale-flow/SOL`. `--status` shows the Stream, `--delete` removes it.

Each `pnpm demo` (devnet) or `pnpm bot` run then opens a tunnel, replaces the Stream with one that points at it, and pauses the Stream on exit. The terminal prints `Copycat's source: reading QuickNode Streams`, and the dashboard footer shows "watcher reads QuickNode Streams". Startup takes 10 to 60 seconds while QuickNode waits for the new tunnel hostname to resolve; Copycat polls RPC meanwhile, so nothing is missed. `--no-streams` (demo) or `--rpc` (bot) skips the Stream.

The free plan allows one active Solana Stream. If `pnpm bot` runs next to the demo, whichever starts last owns the Stream and the other falls back to RPC polling. Start the bot first if the demo should read the Stream.

## Running it on a teammate's machine

Devnet mode does not need Rust, Anchor or the Solana tools; it uses the deployed vault. A teammate needs:

1. **Node 22+**, then clone the repository and run the two build commands above.
2. **The keys.** Send the `.keys/` folder (or the backup file) privately: a password manager share, an encrypted message or in person. Never through Git, a public channel or email. Put it at `.keys/` in their clone and run `chmod 600 .keys/*`.
3. **PostgreSQL**, one of:
   - Linux: install the server package. If its binaries are not in `/usr/bin`, point `PG_BIN` at them, e.g. `set -x PG_BIN /usr/lib/postgresql/17/bin` (fish).
   - macOS: `brew install postgresql@17`, then `set -x PG_BIN (brew --prefix postgresql@17)/bin` (fish) or `export PG_BIN="$(brew --prefix postgresql@17)/bin"` (bash/zsh).
   - Docker: `docker compose up -d postgres`, then set `DATABASE_URL` to `postgres://blindfold:blindfold@127.0.0.1:5432/blindfold`.

   Windows users should run everything inside WSL.
4. `npx -y pnpm@10.33.0 demo`

**One demo at a time across the whole team.** Every run starts its own mint against the same vault, and settlement assumes a single settlement writer: two overlapping runs can misrecord a payout. All runs also share the owner's devnet USDC (about $1.15 per run).

## Run it

```sh
npx -y pnpm@10.33.0 demo
```

The demo pauses before each act; press Enter to continue. It ends with Solana Explorer links for every transaction.

| Option | Effect |
|---|---|
| `--no-pause` | Run straight through (also skips the final hold that keeps the dashboard up, and denies Act 6's approval request without asking, so the run is deterministic) |
| `--no-dashboard` | Don't start the dashboard |
| `--no-streams` | Copycat polls RPC instead of reading the QuickNode Stream |
| `--calls N` | Paid calls per payment method (default 3) |
| `--window S` | Settlement window and hold in seconds (10 to 600, default 30). Act 4 waits for the first window at least one hold after the last call, so up to two windows |
| `--localnet` | Rehearsal on a throwaway local validator with fresh keys; needs `anchor build` and the Solana tools, spends no devnet funds. `LOCALNET_PORT` runs it beside another validator |

A run takes a few minutes, longer on the public RPC. Each run deposits $1.00 of devnet USDC (most of it stays in the vault backing the agent's unspent tokens), pays $0.15 through `exact` and spends about 0.01 SOL in fees. Before the run it tops up the facilitator's SOL from the deployer and the `exact` agent's USDC from the owner when they run low.

### The dashboard

The demo serves a live dashboard at **http://localhost:5173** (the next free port if that one is taken; the demo prints the URL). Open it next to the terminal before Act 1. Each half shows the watcher's signal (Copycat's verdict), the transactions it found onchain, and the agent's purchases as ticks: filled red for standard x402, where each purchase is a public transfer, and hollow for Blindfold. A status line at the bottom shows the `exact` agent's wallet, the Blindfold agent's tokens, what both feeds earned this run and the vault's USDC.

In Act 6 an **owner approval** bar appears at the top when the agent wants the 25-cent trade signals, over the owner's 20-cent limit. Click Approve or Deny, or type `y` in the terminal; whichever answers first wins, and no answer within 60 seconds is a denial.

Transactions appear as Copycat finds them: pushed by the QuickNode Stream when it is connected, otherwise by polling the chain a few seconds after they confirm. The footer shows which source Copycat is reading. Reloading the page replays the run so far. After the summary the demo keeps the dashboard up until you press Enter. For recording, use a 1600x900 or larger browser window; it loads the Geist fonts from Google Fonts and falls back to system fonts offline.

### Second terminal: Copycat on its own

Copycat also runs standalone. It watches TokenFeed's USDC account and the vault using only public data and prints each transaction with its signal and source (`via QuickNode Streams` or `via RPC`):

```sh
npx -y pnpm@10.33.0 bot
```

`--once` prints what is visible in the last 20 transactions per account and exits. `--no-history` skips that initial scan, and `--rpc` polls without the Stream.

### How Copycat knows the token

An `exact` payment is a USDC transfer plus a memo. TokenFeed sets x402's `extra.memo` on its SOL, BTC and ETH routes, as sellers do to reconcile payments, so each transfer carries `whale-flow/SOL` onchain. Without a seller memo, x402 adds a random nonce instead, and Copycat still sees the wallet, the feed, the amounts and the burst: it reports `WATCH WALLET` and follows the wallet's next trade. Copycat cannot see the data the agent bought, so `BUY` is its bet on direction, not knowledge.

## What each act shows

| Act | On screen | What to say |
|---|---|---|
| Setup | Cast, dashboard URL, vault Explorer link | "Your agent buys token data before it trades. Copycat reads public Solana data, looking for someone to front-run." |
| 1. Standard x402 | 3 whale-flow purchases, 3 Explorer links; Copycat: **BUY SOL** | "Every call is a public transfer from the agent's wallet, tagged with what it bought. Copycat knows what your agent is about to trade." |
| 2. Fund | $1.00 deposit, 40 tokens; Copycat sees a deposit | "The owner deposits USDC into a vault. The mint signs tokens blind, so it can't link them to later purchases. The agent holds tokens, not a key." |
| 3. Blindfold | Reserve check, the same 3 purchases plus 2 NewsWire reads; Copycat: **NO SIGNAL** | "Same research. Each payment is a token in an HTTP header: no transaction, nothing for Copycat to read." |
| 4. Settle | Countdown to the next window; the mint's timer pays both feeds $0.10 in one batch, 5 cents carry over; balanced books | "Payouts follow the clock, not the calls. Nothing is paid in the window it was earned, and amounts are rounded, so a payout doesn't reveal when the agent bought or how much. Copycat sees two feeds paid, not which one this owner used." |
| 5. Copycat's report | Everything Copycat learned, side by side | "Same purchases. One told Copycat who, what and when. The other showed money in and money out." |
| 6. Poisoned feed | Gemini agent buys data and decides; it wants the 25-cent signals and the owner approves or denies on the dashboard; the injection's attacker URL is refused, nothing paid | "Privacy without giving up safety. Big purchases wait for you, and the wallet asks, not the model. The feed's response tells the agent to pay an attacker. Whatever the model believes, its tokens only pay registered providers." |
| 7. Replay | Replayed call refused with 402 | "A copied payment buys nothing." |
| 8. Reserve gate | Agent stops with exit code 7 | "If the mint claims more than the vault holds, the agent pays nothing." |

State the limit honestly: payouts still show which registered feeds earned. In this run only one owner deposits, so Copycat can link the batch payout to that owner, though not to the token or the calls; windows, the hold and rounding make timing and amounts weaker signals, not a crowd. The crowd demo below shows what changes with several owners.

## Crowd demo: privacy needs other people

```sh
npx -y pnpm@10.33.0 crowd            # 3 agents; --agents 2..5, --no-pause, --no-dashboard
```

Three agents, each with its own owner wallet, research different tokens (SOL, BTC, ETH) at TokenFeed with interleaved calls. With `exact`, Copycat still sorts the payments by wallet and reports `BUY SOL`, `BUY BTC` and `BUY ETH`, one per wallet. With Blindfold, each owner deposits the same $1.00, the agents make the same purchases with tokens, and one settlement batch pays the feed for all of them. Copycat sees three deposits and one payout and reports **CANNOT ATTRIBUTE**: who bought what, and which token anyone researched, is unknown. For contrast it prints what the same payout would show with a single depositor (`LINKED`).

A second round shows what breaks it: Agent A's owner deposits an odd $2.37 and the others $0.10 each, and each agent spends only that round's tokens. The small deposits together cannot cover the payout, so Copycat reports **PARTIAL** and names the big depositor: it must have bought from TokenFeed, though the token stays hidden. Copycat assumes a round's payout was funded by that round's deposits; older tokens would widen the real crowd, but in a thin pool the guess is right, as it is here.

The crowd dashboard (http://localhost:5173, or the next free port) asks "Who is researching what?". The `exact` side lists every wallet Copycat profiled with its token and `BUY` signal ("3 of 3 named"). The Blindfold side lists the vault's deposits and payouts with "agent ? · bought ?", answers "can't tell" after round 1, then "amounts leak" in round 2 with the big deposit highlighted. Purchases appear as ticks per agent, and the status line shows each agent's tokens, which only the agents know.

It runs on a throwaway local validator only (needs `anchor build` and the Solana tools) and takes about a minute and a half. Each owner and `exact` agent is funded straight from the test USDC mint before Copycat starts watching, the local stand-in for owners who bought USDC independently. A devnet crowd would need owners funded the same way, for example each from faucet.circle.com; funding them from the main owner would put a transfer onchain linking them all.

What it does not hide, and says so at the end: transfers that fund the owners from a common wallet; the payout total, which bounds the crowd's spending; timing patterns across many deposits and payouts; and what the feed and the mint see off chain. Equal deposits matter because a distinctive amount is a fingerprint, and a deposit too small to cover a payout rules its owner out, as round 2 shows.

**For the video:** keep `pnpm demo` as the main story and record `pnpm crowd` as a short separate clip after Act 5, answering "but there is only one user", with the crowd dashboard on screen. A flag on the main demo would add five acts to an already long run.

## Recording tips

- Use a terminal at least 100 columns wide with a large font, and the dashboard in a browser window beside it.
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
| Port 3338, 4000 or 5173 busy | The demo picks free ports automatically and prints them |
| `a validator is already running` (`--localnet`) | Stop the other `solana-test-validator` |
| `QuickNode Streams unavailable, polling RPC: cloudflared not found` | Install cloudflared (see [QuickNode Streams](#quicknode-streams-optional)), or ignore: polling works |
| `QuickNode Streams unavailable ... HTTP 4xx` | Check the API key in `.keys/quicknode.json`. A plan-limit error means another Solana Stream is active in the account: pause it in the QuickNode dashboard |
| `no QuickNode delivery for 20 s; polling RPC` | The tunnel or QuickNode dropped. Copycat keeps going over RPC and switches back when deliveries resume |

For the step-by-step services and the acceptance test, see [Run it locally](RUNNING.md).
