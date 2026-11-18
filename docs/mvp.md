# MVP and add-ons

[Runbook](RUNNING.md) · [Demo](DEMO.md) · [Design](design.md) · [Plan](plan.md)

## Implemented MVP

An owner deposits USDC into the vault and funds a token file. The agent checks reserves and pays for data. The mint rejects replays, tracks provider balances and pays them in sequential Solana batches.

| Component | Implemented behavior |
|---|---|
| Vault | USDC custody, deposit records, provider registration and deactivation, batch settlement, cumulative issuance log. |
| Mint | Blind signing with DLEQ, online redemption, spent-proof tracking, provider balances, settlement recovery and periodic issuance logging. Vault-owned records are the source of deposit credit. |
| Provider | x402 v2 `blindfold` on three paid routes. TokenFeed uses live Coinbase data by default in the standalone API, demo and live stack, with a deterministic fallback. Optional `exact` payments provide the comparison. |
| Wallet and owner CLI | Provider-locked funding, exact-sum selection, payment and recovery checkpoints, per-call cap and owner approval above a configurable threshold. |
| Agent | Scripted and LLM research loops with automatic reserve checks. The LLM loop also limits turns and blocks further purchases once the session spend threshold is reached. |

The [vault deployment notes](design/01-vault.md#10-implementation-notes-and-decisions) record the November 16 devnet acceptance run and the November 17 issuance-log upgrade. The real-vault acceptance procedure covers funding, paid access, replay rejection, settlement, reconciliation and an underfunded reserve report. See [real-vault checks](RUNNING.md#7-real-vault-checks).

## Implemented add-ons

- `pnpm demo` compares `exact` with Blindfold and shows owner approval, a hostile feed response, replay rejection and a failed reserve check. `pnpm crowd` demonstrates the effect of equal and uneven deposit amounts on inference.
- QuickNode Streams feeds Copycat and can trigger an immediate deposit poll. The mint also polls during funding. See [Stream configuration](../README.md#quicknode-streams-configuration).
- `pnpm serve` runs the persistent devnet mint and feeds. The [public replay](https://brockbenton.github.io/blindfold/) and [vault history page](https://brockbenton.github.io/blindfold/vault/) are hosted on GitHub Pages.
- The [gateway](design/06-gateway.md) resells TokenFeed's `exact` routes on devnet using a shared wallet. The [MCP server](../agents/mcp/README.md) exposes provider discovery, quotes, purchases and reserve reports, with owner approval through elicitation when supported.

## Planned or deferred

- Protocol-level owner co-signing. Current approval runs inside the wallet process.
- Durable top-ups through Temporal. Current funding uses persisted checkpoints.
- Independent public reconciliation of the mint's full books. Vault history shows public transactions and issuance totals. Mint-side reconciliation requires admin access.
- Provider revenue privacy. The mint already batches and rounds payouts, and registered payout destinations remain public.
- Refunds, swap/change, key rotation, transport anonymity and mainnet deployment.

The [delivery plan](plan.md#remaining-work) covers the submission checks.
