# Delivery plan

[Implemented scope](mvp.md) · [Runbook](RUNNING.md) · [Demo](DEMO.md) · [Roadmap after submission](roadmap.md)

Submission is due November 20, 2026 at noon CST (18:00 UTC).

## Remaining work

| Date | Work |
|---|---|
| November 18 | Verify the submission revision with the build, type checks, database tests and [real-vault checks](RUNNING.md#7-real-vault-checks). Rehearse the devnet demo with Streams connected. Confirm that the reserve check reads the issuance log and that a Stream deposit hint triggers a poll. Exercise owner approval and refusal, and check the gateway and MCP setup. |
| November 19 | Record the walkthrough video and keep a backup from the public replay. Include the `exact` comparison, the owner approval and refusal, and the crowd demo's amount-correlation example. Verify the published replay, Explorer links and vault history. |
| November 20, before noon CST | Verify the submission links and submit the repo, video and public replay. Check that the README covers the decision loop, spending limits, program ID, Stream configuration and setup. |

Run only one settlement writer against the shared devnet vault during rehearsals and recording. The [live-stack runbook](RUNNING.md#9-live-stack-pnpm-serve) documents the local lock and shared-vault constraint.

## Demo limits

- The issuance log records a public claim. The mint still controls issuance and settlement amounts.
- Deposits and provider payouts are public. Copycat's observations depend on public amounts and timing, and the gateway's upstream purchases remain visible.
- Owner approval and wallet limits govern the model's purchases. The wallet refuses any offer larger than the session budget left. A compromised process or leaked token file can still spend at allowed providers.
- A paid response can be lost after redemption. Funding checkpoints can require manual reconciliation after an uncertain deposit.
