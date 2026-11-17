# MVP and add-ons

[Runbook](RUNNING.md) · [Demo](DEMO.md) · [Design](design.md) · [Plan](plan.md)

## Implemented MVP

The target is a paid API call backed by a real Solana vault: owner deposit, token issuance, agent payment, replay rejection, provider settlement and a fail-closed reserve check.

| Component | Implemented behavior |
|---|---|
| Vault | `initialize`, `deposit`, `register_provider`, `deactivate_provider`, `settle_batch` |
| Mint | Blind signing, DLEQ, spent set, provider balances, deposit polling and settlement recovery |
| Mock paid API | x402 v2 `blindfold` challenge, online redemption before serving data |
| Wallet and owner CLI | Provider-locked funding, exact-sum payments, per-call cap, owner approval above a threshold and pending-payment recovery |
| Scripted agent | Provider discovery, topic selection, reserve gate and result reporting |

The [vault notes](design/01-vault.md#10-implementation-notes-and-decisions) record localnet and devnet acceptance on November 16, 2026. The reproducible acceptance command is `pnpm --filter @blindfold/scripts e2e` with a deployed vault, funded devnet keys and PostgreSQL. Local tests exercise the same application components with a fake chain; they do not prove current devnet availability.

Acceptance requires:

1. The owner deposits USDC and receives tokens.
2. The agent buys data after checking onchain reserves.
3. A replay is rejected without a second provider credit.
4. `settle_batch` pays the provider in USDC.
5. Reconciliation matches the isolated test's deposits and payouts.
6. The agent refuses payment when reported liabilities exceed the vault balance.

## Add-ons

Planned, in priority order. Existing hooks and tests are not complete demos.

1. **Copycat and baseline comparison.** Implemented: the mock API accepts standard x402 `exact` alongside `blindfold` when configured, Copycat (`scripts/bot.ts`) reports what a chain observer sees and infers trading signals, and `pnpm demo` compares both with a live dashboard; `pnpm crowd` shows that several equal depositors and one payout cannot be attributed ([demo](DEMO.md)). Copycat reads a QuickNode Stream, with token account polling as the fallback.
2. **LLM agent and prompt-injection demo.** Implemented: `agent --llm` runs a model-driven decision loop with code-enforced limits ([agent](design/05-agent.md#llm-decision-loop)), and `pnpm demo` Act 6 poisons a feed response with an injection pointing at an attacker; payment to the unregistered attacker is refused. Not yet shown: an allowed provider consuming the whole budget.
3. **QuickNode Stream.** Implemented for Copycat: a `solana-devnet` block Stream with a checked-in filter and a webhook into `pnpm demo` and `pnpm bot`, created by `pnpm streams:setup` ([README](../README.md#quicknode-streams-configuration)). A Stream `DepositMade` also triggers an immediate mint deposit poll (never a credit).
4. **Owner approval.** Implemented in the wallet: a price above `APPROVAL_OVER_CENTS` waits for the owner (terminal prompt, the demo dashboard, denial on timeout), and `pnpm demo` Act 6 shows it ([agent](design/05-agent.md#owner-approval)). Not yet: a protocol-level co-signed reserve pocket that a compromised agent process could not bypass; current 1-of-N locks and redemption validation do not support it.
5. **Temporal top-up.** Recover multi-step funding through a durable workflow; do not equate the current checkpoint files with exactly-once execution.
6. **Onchain issuance log and reconciliation view.** Implemented: the vault's `IssuanceLog` PDA holds the mint's cumulative issued total (only grows) and a settled total advanced by `settle_batch`; the agent's reserve check uses it. Built and tested on localnet; the devnet program still needs the upgrade. Not done: a public reconciliation view.
7. **Hidden provider revenue.** Partly implemented: fixed settlement windows, a hold and rounded payouts ([settlement privacy](design/02-mint.md#46-settlement-privacy)). Not done: hiding which provider earned, which needs fresh payout accounts and a new registry trust model.

Cut lower-priority add-ons first. Refunds, key rotation, Tor/OHTTP and standard Cashu-wallet support are deferred. Mainnet, multiple mint operators and an onchain escape hatch are outside the current scope.

## Submission checklist

Document the decision loop, spending limits, program ID, deployment evidence and threat model. The README's [QuickNode Streams](../README.md#quicknode-streams-configuration) section covers the Stream's network, dataset, filter and destination, and states that the mint still polls.
