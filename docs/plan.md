# Delivery plan

[Implemented scope](mvp.md) · [Runbook](RUNNING.md) · [Design](design.md)

## Schedule (2026)

| When | Work |
|---|---|
| November 15–18 | Integration and remaining demo work |
| November 19 | Demo video and recorded backup |
| November 20, noon CST (18:00 UTC) | Submission |
| November 21 | Closing ceremony |

The original component build is present. The [vault notes](design/01-vault.md#10-implementation-notes-and-decisions) record a November 14 devnet acceptance run. Re-run acceptance before recording; a historical pass does not establish current RPC, key or deployment availability.

## Remaining work

1. Keep the TypeScript build, type checks and PostgreSQL-backed tests passing; validate the real vault separately with the [runbook](RUNNING.md).
2. Build the `exact` baseline and competitor-bot comparison, then the full hostile-response demo. The mock API currently offers only `cashu`.
3. Add QuickNode Streams only after the base demo is repeatable. Polling already supports the mint workflow.
4. Consider owner approval, Temporal, issuance logging and hidden revenue in the [add-on order](mvp.md#add-ons). Do not present them as implemented.
5. Record a backup with known balances, provider configuration and matching program/keypair IDs.

## Risks to demonstrate honestly

- **Custody:** the mint can lie about issuance and misuse settlement authority. Public reserves do not make it trustless.
- **Privacy:** a public observer sees deposits and provider payouts. Timing, amounts and few users can correlate purchases; the demo should state exactly what the observer can access.
- **Agent compromise:** provider locks stop arbitrary-recipient redemption, but allowed providers can still receive the entire budget. A token leak can fund purchases at those providers.
- **Recovery:** a lost paid response can consume tokens without returning data. Funding checkpoint recovery is not exactly-once deposit execution.
- **Scope:** finish the baseline comparison and hostile-response demo before adding unrelated services.

## Open design question

Hiding provider revenue would require changing the fixed onchain payout registry or the withdrawal protocol. Decide that trust tradeoff before implementing fresh payout addresses.
