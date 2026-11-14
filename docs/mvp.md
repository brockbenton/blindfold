# MVP and add-ons

[Runbook](RUNNING.md) · [Design](design.md) · [Plan](plan.md)

## Implemented MVP

The target is a paid API call backed by a real Solana vault: owner deposit, token issuance, agent payment, replay rejection, provider settlement and a fail-closed reserve check.

| Component | Implemented behavior |
|---|---|
| Vault | `initialize`, `deposit`, `register_provider`, `deactivate_provider`, `settle_batch` |
| Mint | Blind signing, DLEQ, spent set, provider balances, deposit polling and settlement recovery |
| Mock paid API | x402 v2 `cashu` challenge, online redemption before serving data |
| Wallet and owner CLI | Provider-locked funding, exact-sum payments, per-call cap and pending-payment recovery |
| Scripted agent | Provider discovery, topic selection, reserve gate and result reporting |

The [vault notes](design/01-vault.md#10-implementation-notes-and-decisions) record localnet and devnet acceptance on November 14, 2026. The reproducible acceptance command is `pnpm --filter @blindfold/scripts e2e` with a deployed vault, funded devnet keys and PostgreSQL. Local tests exercise the same application components with a fake chain; they do not prove current devnet availability.

Acceptance requires:

1. The owner deposits USDC and receives tokens.
2. The agent buys data after checking onchain reserves.
3. A replay is rejected without a second provider credit.
4. `settle_batch` pays the provider in USDC.
5. Reconciliation matches the isolated test's deposits and payouts.
6. The agent refuses payment when reported liabilities exceed the vault balance.

## Add-ons

Planned, in priority order. Existing hooks and tests are not complete demos.

1. **Competitor bot and baseline comparison.** Add a standard `exact` option to the provider and compare the public-chain observations with the `cashu` flow. Neither the baseline nor bot is implemented.
2. **Prompt-injection demo.** Use the hostile-response hook to show an attempted payment outside the token signer set being refused. Also show that an allowed provider can still consume the budget.
3. **QuickNode Stream.** Trigger the deposit poller from a webhook and feed the bot. No Stream or webhook configuration exists yet.
4. **Owner approval.** Add a co-signed reserve pocket. Current 1-of-N locks and redemption validation do not support this.
5. **Temporal top-up.** Recover multi-step funding through a durable workflow; do not equate the current checkpoint files with exactly-once execution.
6. **Onchain issuance log and reconciliation view.** The admin reconciliation endpoint exists; public issuance evidence does not.
7. **Hidden provider revenue.** Revisit fixed payout accounts, fees and registry trust before implementing fresh addresses or chunked withdrawals.

Cut lower-priority add-ons first. Refunds, key rotation, an approval UI, Tor/OHTTP and standard Cashu-wallet support are deferred. Mainnet, multiple mint operators and an onchain escape hatch are outside the current scope.

## Submission checklist

Document the decision loop, spending limits, program ID, deployment evidence and threat model. If a Stream is built, include its network, dataset, filter and destination; otherwise state that the mint uses polling.
