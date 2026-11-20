# Blindfold — Devpost submission

---

## Elevator pitch (≤200 chars)

AI agents that pay per API call with x402 leak their research onchain. Blindfold pays with blind-signed ecash backed by a Solana USDC vault, so purchases leave no per-call transaction.

---

## About the project

### Inspiration

Data vendors like CoinGecko, CoinMarketCap, Birdeye and Messari now sell pay-per-request access over **x402**: an agent hits an endpoint, gets an HTTP `402 Payment Required`, pays a few cents in USDC, and gets the data. No account, no API key. It works well for agents.

It also leaks. With the standard x402 `exact` scheme on Solana, every call is a public USDC transfer from the agent's wallet to the vendor. Sellers often attach a memo for reconciliation, so a transfer can read `whale-flow/SOL`. Anyone watching the chain learns **who** is researching, **what** they're looking at, **when**, and **how often**. A burst of SOL whale-flow purchases from a wallet that also trades is a front-running signal.

Traditional finance already pays to hide intent: dark pools carry a large share of US equity volume because displayed orders get traded against. Ethereum users route through private relays so bots can't front-run them. We wanted the same thing one step earlier: hide the **data purchases** that come before a trade.

### What it does

Blindfold is a custom **x402 v2 scheme** called `blindfold`:

1. An **owner** deposits USDC into a shared Solana vault and receives **blind-signed Cashu ecash tokens** from a mint. The tokens are locked to the keys of registered data providers.
2. The **agent** holds the tokens, not a wallet key. When a provider answers with HTTP 402, the agent pays in the `PAYMENT-SIGNATURE` header with exact-change proofs.
3. The **provider** redeems the proofs at the mint before serving the data. Nothing goes onchain.
4. The **mint** settles provider balances from the vault in batches on fixed windows, using a hold and rounded amounts.

Each direct Blindfold purchase leaves **zero transactions** for a watcher to read. The provider keeps its existing `exact` route too: Blindfold is just one more entry in the route's `accepts` list.

We also built a lot of agent safety into the wallet, because an agent reading untrusted feeds can be manipulated:

- **Provider lock:** tokens can only be redeemed by registered providers, so a prompt-injected "pay this URL" goes nowhere.
- **Per-call cap, session budget and owner approval** above a threshold, enforced in the wallet, outside the model.
- **Reserve gate:** before paying, the agent reads the vault balance and the onchain issuance log itself and refuses if the mint has issued more than the vault holds.

You can use it from a CLI agent, an LLM-driven research loop, or an **MCP server** that drops into Claude Code or Claude Desktop.

### How we built it

**Onchain (Rust, Anchor 1.2.2, Solana devnet).** The vault program (`EsB6NfKVPipU5kEVm2jq14cjopbE7w9hPEFZWVu8jtMo`) holds USDC, keeps a provider registry, records deposits as `DepositRecord` PDAs, and pays providers through `settle_batch` with sequential batch IDs. Each batch pays 1 to 8 providers, and only to their registered accounts. An `IssuanceLog` PDA publishes the mint's cumulative issued total and the settled total, so anyone can check reserves.

**The mint (TypeScript, Hono, PostgreSQL).** It credits quotes from onchain deposits, blind-signs outputs with DLEQ proofs, rejects double spends, and runs settlement. Blind signing follows Cashu's BDHKE. For a secret $x$, the wallet computes $Y = H(x)$, where $H$ hashes to a curve point, blinds it with a random $r$, and sends

$$B' = Y + rG.$$

The mint signs with its key $k$ (public key $K = kG$) and returns $C' = kB'$. The wallet unblinds:

$$C = C' - rK = kY.$$

The mint later sees $(x, C)$ when a provider redeems, but it never saw $Y$ at signing time, so it can't link the redemption to the deposit that paid for it. The DLEQ proof lets the owner check that $C'$ was signed with the published $K$.

Settlement holds recent redemptions for one window and rounds each payout down to a multiple of 10¢:

$$\text{payout}_p = 10 \cdot \left\lfloor \frac{\text{owed}_p}{10} \right\rfloor \ \text{cents},$$

and the remainder carries over, so the payout amount doesn't reveal the exact number of calls.

The reserve check the agent runs before paying is

$$\text{vault USDC} \;\ge\; \max\big(\text{issued} - \text{settled},\ \text{mint-reported liabilities}\big),$$

where $\text{issued}$ and $\text{settled}$ come from the onchain issuance log.

**x402 integration.** We used the official `@x402/core`, `@x402/hono` and `@x402/fetch` packages and registered `blindfold` as a new scheme next to `exact`. We started with a throwaway spike (`spikes/x402-cashu`) that ran a real x402 server and client with real `cashu-ts` crypto to show the idea worked before building the rest.

**Wallet SDK and agents.** The wallet does provider-locked funding, exact-change proof selection, approval hooks, budget checks under a payment lock, and recovery of pending proofs. On top of it sit a scripted CLI agent, an LLM loop (Gemini or any OpenAI-compatible model), and an MCP server exposing `list_providers`, `get_balance`, `quote`, `buy_data` and `check_reserves`, with MCP elicitation for owner approval.

**Providers.** TokenFeed serves whale flow, order-book depth and trade signals (Coinbase market data with a deterministic fallback) at 5¢, 10¢ and 25¢. A **gateway** accepts Blindfold tokens and buys from upstream `exact` vendors out of one shared wallet, so existing x402 vendors can be reached without per-agent transfers.

**Watching the chain (QuickNode Streams).** To prove the point we built the adversary. A **QuickNode Stream** on Solana devnet runs a filter that keeps only transactions touching watched USDC accounts, extracts amounts and SPL memos, and decodes vault `DepositMade` events. Our observer reads that feed (with RPC fallback), profiles wallets, and issues signals like `BUY SOL`. Deposit events also tell the mint to poll for new deposits right away.

**Demo and scoring.** `pnpm demo` runs eight acts on devnet with a live dashboard. Act 5 scores the observer against the ground-truth purchase list:

- Standard x402: **3/3** purchases attributed (wallet, feed and token), 3 per-call transfers.
- Blindfold: **0/5** purchases attributed, 0 per-call transfers.

A public replay and a vault history page (reserve coverage verdict, deposits, settlements, issuance totals, read live from devnet in the browser) are on GitHub Pages.

### Challenges we ran into

- **Privacy needs a crowd.** With one depositor, the observer can still tie the owner's deposit to the batch payout. It can't tell which token or how many calls, but it knows who paid which feed. We built a separate **crowd demo** to measure this honestly. With $n$ equal deposits and one payout, the observer's best guess at who bought what is about $1/n$, and it reports `CANNOT ATTRIBUTE`. Then we broke it on purpose. In round two, one owner deposits an odd $2.37 and the others $0.10. The small deposits can't cover the payout, so the observer names the big depositor (`PARTIAL`). Distinctive amounts are fingerprints.
- **Trusting a custodial mint.** Ecash mints are custodial. We couldn't remove that, so we made it checkable: the onchain issuance log, the agent's reserve gate, and a public coverage page. The mint can still under-report issuance, and we say so in the README.
- **Scoring privacy without fooling ourselves.** "The observer saw nothing" only means something if the observer actually read everything. The scorer checks RPC coverage of every watched account across each act's slot window. If coverage has holes and nothing was attributed, the result is reported as **inconclusive**, not as a privacy win.
- **Budgets under concurrency.** The first session budget only checked the price the model asked for. We moved the check into the wallet, under its payment lock, against the actual 402 offer, so neither a runaway loop nor a final oversized offer can push past the budget before any proof leaves.
- **Settlement and redemption edge cases.** Redemption happens before delivery, so a dropped response can cost tokens. Settlement and funding have to survive crashes between "signed" and "confirmed." We fixed the most important cases and wrote the rest into the roadmap.
- **One shared devnet vault.** Running several settlement writers against the same vault during rehearsals produced batch-ID races, so we added a local settle lock.

### What we learned

- x402 v2 is extensible enough that a whole new payment rail fits in as one more `accepts` entry, and existing `exact` clients keep working.
- Blind signatures solve the linkage problem cleanly, but **metadata is what's left**: deposit amounts, timing, payout totals and which providers got paid. Privacy is a property of the crowd, not the cryptography alone.
- Agent safety belongs in the wallet, not the prompt. The model can be talked into anything; the wallet's lock, cap, budget and reserve gate don't negotiate.
- Building the attacker first (the observer and the scorer) kept our claims honest.

### What's next

Reproducible reserve snapshots, a same-workload privacy benchmark across tagged `exact`, nonce-only `exact` and Blindfold, recoverable delivery on the gateway (no double charge after a disconnect), a packaged provider adapter, and owner-selected provider groups. Mainnet is deliberately not next: custody and recovery need to be stronger first.

---

## Built with (tags)

solana, anchor, rust, typescript, node.js, x402, cashu, cashu-ts, usdc, spl-token, solana-kit, solana-web3.js, hono, postgresql, quicknode, quicknode-streams, model-context-protocol, claude, gemini, vitest, pnpm, github-actions, github-pages, cloudflare-tunnel, docker

---

## "Try it out" links

- Code: https://github.com/brockbenton/blindfold
- Public replay: https://brockbenton.github.io/blindfold/
- Live vault history (devnet): https://brockbenton.github.io/blindfold/vault/
- Vault on Solana Explorer: https://explorer.solana.com/address/EsB6NfKVPipU5kEVm2jq14cjopbE7w9hPEFZWVu8jtMo?cluster=devnet

---

## Sponsor / special prizes

- Agentic Payments and AI – Track Winner
- Agentic Payments and AI – Best use of Solana
- Bounty – Best Use of QuickNode Streams

**Main track:** Agentic Payments and AI
**Chain award:** Best use of Solana
**Bounty submissions:** Best Use of QuickNode Streams

---

## Project description (the long form field)

**Blindfold lets AI agents pay for data per call over x402 without broadcasting what they're researching onchain.**

**What did you build?**
A custom x402 v2 payment scheme, `blindfold`, backed by a Solana USDC vault. Owners deposit USDC into the vault and receive blind-signed Cashu ecash tokens locked to registered data providers. Agents pay for API calls with those tokens in an HTTP header. Providers redeem at the mint and get paid from the vault in batched settlements. The project includes the Anchor vault program, the mint, a wallet SDK with owner CLI, a CLI agent, an LLM research loop, an MCP server for Claude, a data provider (TokenFeed), a gateway to existing x402 vendors, and a chain observer that plays the adversary.

**What problem does it solve?**
Standard x402 `exact` payments on Solana are public USDC transfers, often with a memo naming the feed or token. A watcher can see which wallet is buying which data, how often, and right before which trade. That's a front-running signal. Blindfold removes the per-call transaction, so there's nothing to read.

**How does it work?**
Deposit → blind-signed tokens (with DLEQ proofs) → agent pays in the `PAYMENT-SIGNATURE` header → provider redeems at the mint before serving → mint settles from the vault on fixed windows with a hold and 10¢ rounding. The agent checks reserves itself against an onchain issuance log before paying. The wallet enforces a provider lock, a per-call cap, a session budget and owner approval outside the model, so a prompt-injected feed can't redirect or drain funds.

**What makes it unique?**
Other private x402 work mostly uses zero-knowledge or encryption on EVM chains. Other Cashu-over-402 projects are Bitcoin/Lightning backed. Blindfold is ecash backed by **USDC in a Solana vault the agent can audit**, and it plugs into existing x402 routes next to `exact`. We also measure the privacy claim: the demo scores the observer against ground truth (standard x402: 3/3 purchases attributed; Blindfold: 0/5, 0 per-call transfers), and a crowd demo shows both where privacy holds and where deposit amounts break it.

**What would you build next?**
Reproducible reserve snapshots, a same-workload privacy benchmark, recoverable delivery so a dropped response never charges twice, a packaged provider adapter, and owner-selected provider groups.

**Technologies / sponsor tools:**
Solana (devnet), Anchor, Rust, SPL Token, SPL Memo, Circle devnet USDC, **QuickNode Streams** (filtered Solana block stream feeding the observer and deposit polling), x402 v2 (`@x402/core`, `@x402/hono`, `@x402/fetch`, `@x402/svm`), Cashu (`cashu-ts`), TypeScript, Node.js, Hono, PostgreSQL, Model Context Protocol (Claude Code / Claude Desktop), Gemini (LLM agent), Vitest, GitHub Actions and Pages.

---

## Technical summary — contract / program addresses (Solana devnet)

| Program / account | Address | Role |
|---|---|---|
| Blindfold vault (deployed by us) | `EsB6NfKVPipU5kEVm2jq14cjopbE7w9hPEFZWVu8jtMo` | Custody, provider registry, deposits, batched settlement, issuance log |
| Circle devnet USDC mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | Settlement asset |
| SPL Token | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | USDC transfers (`transfer_checked`) |
| Associated Token Account | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` | Vault USDC account |
| SPL Memo | `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` | Seller memos on standard x402 baseline payments |
| System Program | `11111111111111111111111111111111` | Account creation |
