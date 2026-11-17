# MVP and add-ons

[Runbook](RUNNING.md) · [Demo](DEMO.md) · [Design](design.md) · [Plan](plan.md)

## Implemented MVP

The target is a paid API call backed by a real Solana vault: owner deposit, token issuance, agent payment, replay rejection, provider settlement and a fail-closed reserve check.

| Component | Implemented behavior |
|---|---|
| Vault | `initialize`, `deposit`, `register_provider`, `deactivate_provider`, `settle_batch` |
| Mint | Blind signing, DLEQ, spent set, provider balances, deposit polling and settlement recovery |
| Mock paid API | x402 v2 `cashu` challenge, online redemption before serving data |
| Wallet and owner CLI | Provider-locked funding, exact-sum payments, per-call cap and pending-payment recovery |
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

1. **Copycat and baseline comparison.** Implemented: the mock API accepts standard x402 `exact` alongside `cashu` when configured, Copycat (`scripts/bot.ts`) reports what a chain observer sees and infers trading signals, and `pnpm demo` compares both with a live dashboard; `pnpm crowd` shows that several equal depositors and one payout cannot be attributed ([demo](DEMO.md)). Copycat polls token account history; it does not use a Stream yet.
2. **LLM agent and prompt-injection demo.** Implemented: `agent --llm` runs a model-driven decision loop with code-enforced limits ([agent](design/05-agent.md#llm-decision-loop)), and `pnpm demo` Act 6 poisons a feed response with an injection pointing at an attacker; payment to the unregistered attacker is refused. Not yet shown: an allowed provider consuming the whole budget.
3. **QuickNode Stream.** Trigger the deposit poller from a webhook and feed the bot. No Stream or webhook configuration exists yet.
4. **Owner approval.** Add a co-signed reserve pocket. Current 1-of-N locks and redemption validation do not support this.
5. **Temporal top-up.** Recover multi-step funding through a durable workflow; do not equate the current checkpoint files with exactly-once execution.
6. **Onchain issuance log and reconciliation view.** The admin reconciliation endpoint exists; public issuance evidence does not.
7. **Hidden provider revenue.** Revisit fixed payout accounts, fees and registry trust before implementing fresh addresses or chunked withdrawals.

Cut lower-priority add-ons first. Refunds, key rotation, an approval UI, Tor/OHTTP and standard Cashu-wallet support are deferred. Mainnet, multiple mint operators and an onchain escape hatch are outside the current scope.

## Submission checklist

Document the decision loop, spending limits, program ID, deployment evidence and threat model. If a Stream is built, include its network, dataset, filter and destination; otherwise state that the mint uses polling.
