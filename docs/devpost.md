# Blindfold — Devpost submission

---

## Elevator pitch (≤200 chars)

AI agents that pay per API call with x402 leak their research onchain. Blindfold pays with blind-signed ecash backed by a Solana USDC vault, so purchases leave no per-call transaction.

---

## About the project

### Inspiration

Data vendors like CoinGecko, CoinMarketCap, Birdeye and Messari now sell pay-per-request access over **x402**: an agent hits an endpoint, gets an HTTP `402 Payment Required`, pays a few cents in USDC, and gets the data. No account or API key needed, which makes it a good fit for agents.

The problem is that with the standard x402 `exact` scheme on Solana, every call is a public USDC transfer from the agent's wallet to the vendor. Sellers often attach a memo for reconciliation, so a transfer can literally say `whale-flow/SOL`. Anyone watching the chain can see which wallet is buying which feed and how often. If that same wallet trades, a run of SOL whale-flow purchases right before a trade is something a bot can front-run.

People already go to some lengths to hide trading intent. Dark pools exist because displayed orders get traded against, and Ethereum users send transactions through private relays to avoid MEV bots. We hadn't seen anyone do this for the data lookups that happen before the trade, so that's what we built.

### What it does

Blindfold is a custom **x402 v2 scheme** called `blindfold`:

1. An **owner** deposits USDC into a shared Solana vault and receives **blind-signed Cashu ecash tokens** from a mint. The tokens are locked to the keys of registered data providers.
2. The **agent** holds the tokens, not a wallet key. When a provider answers with HTTP 402, the agent pays in the `PAYMENT-SIGNATURE` header with exact-change proofs.
3. The **provider** redeems the proofs at the mint before serving the data. Nothing goes onchain.
4. The **mint** settles provider balances from the vault in batches on fixed windows, using a hold and rounded amounts.

A direct Blindfold purchase doesn't create any transaction at all. Providers don't have to give up their `exact` route either; Blindfold is added as another entry in the route's `accepts` list.

Since the agent is reading untrusted feeds and could get prompt-injected, the wallet also has some guardrails:

- **Provider lock:** tokens can only be redeemed by registered providers, so a prompt-injected "pay this URL" goes nowhere.
- **Per-call cap, session budget and owner approval** above a threshold, enforced in the wallet, outside the model.
- **Reserve gate:** before paying, the agent reads the vault balance and the onchain issuance log itself and refuses if the mint has issued more than the vault holds.

There's a CLI agent, an LLM research loop, and an MCP server you can add to Claude Code or Claude Desktop.

### How we built it

**Onchain (Rust, Anchor 1.2.2, Solana devnet).** The vault program (`EsB6NfKVPipU5kEVm2jq14cjopbE7w9hPEFZWVu8jtMo`) holds USDC, keeps a provider registry, records deposits as `DepositRecord` PDAs, and pays providers through `settle_batch` with sequential batch IDs. Each batch pays 1 to 8 providers, and only to their registered accounts. An `IssuanceLog` PDA publishes the mint's cumulative issued total and the settled total, so anyone can check reserves.

**The mint (TypeScript, Hono, PostgreSQL).** It credits quotes from onchain deposits, blind-signs outputs with DLEQ proofs, rejects double spends, and runs settlement. Blind signing follows Cashu's BDHKE. For a secret $x$, the wallet computes $Y = H(x)$, where $H$ hashes to a curve point, blinds it with a random $r$, and sends

$$B' = Y + rG.$$

The mint signs with its key $k$ (public key $K = kG$) and returns $C' = kB'$. The wallet unblinds:

$$C = C' - rK = kY.$$

The mint later sees $(x, C)$ when a provider redeems, but it never saw $Y$ at signing time, so it can't link the redemption to the deposit that paid for it. The DLEQ proof lets the owner check that $C'$ was signed with the published $K$.

Settlement holds recent redemptions for one window and rounds each payout down to a multiple of 10¢:

$$\text{payout}_p = 10 \cdot \left\lfloor \frac{\text{owed}_p}{10} \right\rfloor \ \text{cents},$$

with the remainder carried into the next window, so you can't back out the exact number of calls from the payout.

The reserve check the agent runs before paying is

$$\text{vault USDC} \;\ge\; \max\big(\text{issued} - \text{settled},\ \text{mint-reported liabilities}\big),$$

where $\text{issued}$ and $\text{settled}$ come from the onchain issuance log.

**x402 integration.** We used the official `@x402/core`, `@x402/hono` and `@x402/fetch` packages and registered `blindfold` as a new scheme next to `exact`. Before building anything else we wrote a quick spike (`spikes/x402-cashu`) with a real x402 server and client and real `cashu-ts` crypto, to make sure the idea actually worked.

**Wallet SDK and agents.** The wallet does provider-locked funding, exact-change proof selection, approval hooks, budget checks under a payment lock, and recovery of pending proofs. On top of it sit a scripted CLI agent, an LLM loop (Gemini or any OpenAI-compatible model), and an MCP server exposing `list_providers`, `get_balance`, `quote`, `buy_data` and `check_reserves`, with MCP elicitation for owner approval.

**Providers.** TokenFeed serves whale flow, order-book depth and trade signals (Coinbase market data with a deterministic fallback) at 5¢, 10¢ and 25¢. We also wrote a gateway that takes Blindfold tokens and buys from upstream `exact` vendors out of one shared wallet, so agents can use existing x402 vendors without each making their own transfers.

**Watching the chain (QuickNode Streams).** We wanted to show the leak, not just describe it, so we built the attacker too. A QuickNode Stream on Solana devnet runs a filter that keeps only transactions touching watched USDC accounts, extracts amounts and SPL memos, and decodes vault `DepositMade` events. Our observer reads that feed (with RPC fallback), profiles wallets, and issues signals like `BUY SOL`. Deposit events also tell the mint to poll for new deposits right away.

**Demo and scoring.** `pnpm demo` runs eight acts on devnet with a live dashboard. Act 5 scores the observer against the ground-truth purchase list:

- Standard x402: **3/3** purchases attributed (wallet, feed and token), 3 per-call transfers.
- Blindfold: **0/5** purchases attributed, 0 per-call transfers.

A public replay and a vault history page (reserve coverage verdict, deposits, settlements, issuance totals, read live from devnet in the browser) are on GitHub Pages.

### Challenges we ran into

- **Privacy only works with other users.** If there's only one depositor, the observer can still match their deposit to the batch payout. It can't see which token or how many calls, but it does know who paid for which feed. We built a separate crowd demo to measure this. With $n$ equal deposits and one payout, the observer's best guess is about $1/n$ and it reports `CANNOT ATTRIBUTE`. In a second round one owner deposits $2.37 and everyone else deposits $0.10. The small deposits can't add up to the payout, so the observer correctly picks out the big depositor (`PARTIAL`). Unusual deposit amounts give you away.
- **The mint is custodial.** That's true of every ecash mint and we didn't find a way around it. What we could do was make it auditable with the onchain issuance log, the agent's reserve check, and a public coverage page. The mint could still under-report what it issued, which the README calls out.
- **Making sure the privacy score meant something.** An observer that attributes nothing could just be an observer that missed transactions. The scorer checks that RPC actually covered every watched account for each act's slot range, and if there are gaps and nothing got attributed, it marks the result inconclusive.
- **Budgets under concurrency.** Our first version of the session budget only checked the price the model asked for. We moved the check into the wallet, under the payment lock, and compared it against the actual 402 offer, so a looping agent or an inflated offer can't go over budget.
- **Settlement and redemption edge cases.** Providers redeem before they deliver, so a dropped response can lose tokens. Settlement and funding also need to survive a crash between "signed" and "confirmed". We fixed the worst of these and put the rest on the roadmap.
- **One shared devnet vault.** During rehearsals we had multiple processes settling against the same vault and hit races on batch IDs, so we added a local settle lock.

### What we learned

- x402 v2 makes it easy to add a new scheme. Ours is one more `accepts` entry and `exact` clients don't notice.
- Blind signatures take care of linking a payment to a deposit. What's left is metadata: deposit amounts, timing, payout totals and which providers got paid. How private it is in practice depends a lot on how many people are using it.
- Spending limits need to live in the wallet code. A model can be convinced to do almost anything, but it can't change the cap or the budget if they aren't in its prompt.
- Building the observer and scorer early meant every privacy claim had a number behind it.

### What's next

Reproducible reserve snapshots, a privacy benchmark that runs the same workload through tagged `exact`, nonce-only `exact` and Blindfold, recoverable delivery on the gateway so a disconnect doesn't charge twice, a packaged provider adapter, and letting owners pick provider groups. We're not planning a mainnet launch yet because custody and recovery need more work first.

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
Standard x402 `exact` payments on Solana are public USDC transfers, often with a memo naming the feed or token. A watcher can see which wallet is buying which data, how often, and right before which trade. That can be used to front-run them. With Blindfold there's no per-call transaction to look at.

**How does it work?**
Deposit → blind-signed tokens (with DLEQ proofs) → agent pays in the `PAYMENT-SIGNATURE` header → provider redeems at the mint before serving → mint settles from the vault on fixed windows with a hold and 10¢ rounding. The agent checks reserves itself against an onchain issuance log before paying. The wallet enforces a provider lock, a per-call cap, a session budget and owner approval outside the model, so a prompt-injected feed can't send funds somewhere else or burn through the budget.

**What makes it unique?**
Most of the private x402 work we found uses zero-knowledge proofs or encryption on EVM chains, and the other Cashu-over-402 projects are backed by Bitcoin/Lightning. Blindfold's ecash is backed by USDC in a Solana vault that the agent can audit itself, and it sits next to `exact` on existing x402 routes. We also tested the privacy claim instead of just asserting it: the demo scores the observer against ground truth (standard x402: 3/3 purchases attributed; Blindfold: 0/5, 0 per-call transfers), and a crowd demo shows both where privacy holds and where deposit amounts break it.

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
