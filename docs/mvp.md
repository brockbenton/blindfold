# Blindfold: MVP and add-ons

What we build. Why is in [`README.md`](../README.md), how in [`design.md`](design.md), when in [`plan.md`](plan.md).

## MVP

**Goal:** one paid API call working end to end on Solana devnet. Keep it basic, but make it real. Get this working before expanding the protocol or the agent.

### Components

1. **Vault** (Anchor program). Holds devnet USDC. Instructions: `deposit`, `register_provider`, `settle_batch`.
2. **Mint** (TypeScript + Postgres, `cashu-ts`). Blind-signs tokens, redeems them, keeps the spent set and provider balances.
3. **Mock paid API.** Returns an x402 `402` offering the `cashu` scheme and serves data once it gets a valid token.
4. **Agent wallet SDK.** Holds the tokens, handles the x402 handshake and retries with payment.
5. **Simple agent.** Checks the vault's reserves onchain, then makes at least one paid call through the wallet.

### Done when

- [x] The owner deposits USDC into the vault and receives tokens.
- [x] The agent calls the mock API, gets a 402, pays with a token and gets the data.
- [x] The mint rejects a replayed token.
- [x] The agent reads the vault balance from Solana and refuses to pay when reserves don't cover outstanding tokens.
- [x] `settle_batch` pays the provider in USDC on devnet.

## Add-ons

In priority order.

1. **Competitor bot and split screen.** Run the same research task over normal x402 (`exact` scheme) and over Blindfold (`cashu` scheme), against one provider endpoint that offers both. The bot copies the trade in the first case and sees nothing in the second. This is the core of the demo.
2. **Prompt injection beat.** A poisoned API response tells the agent to pay an unknown provider. The payment fails because the tokens are locked to allowlisted providers.
3. **QuickNode Stream.** Watches vault deposits, triggers the top-up and feeds the bot. Qualifies us for the $500 bounty.
4. **Owner approval.** A small allowance the agent can spend alone, plus a reserve that needs the owner's co-signature, signed from the CLI.
5. **Temporal top-up workflow.** Deposit, sign and issue as one durable workflow. Demo moment: kill the worker mid-top-up and it recovers.
6. **Issuance log and reconciliation view.** Show that issued minus paid out matches the vault balance.
7. **Hidden provider revenue.** Fresh payout addresses, fixed-size chunks, and the mint pays the fees.

**Cut order if behind:** drop add-ons from the bottom up. Split screen can shrink to a terminal view. **Don't cut** add-ons 1 and 2; they are the demo.

**Deferred:** refunds, key rotation, approval UI, Tor / Oblivious HTTP, a standard Cashu wallet holding our tokens.

**Out of scope:** mainnet, real providers, our own crypto, multiple mint operators, an onchain escape hatch (pitch as future work).

## Submission README must include

Decision loop, safety limits, program IDs, Stream config (network, dataset, filter, destination), threat model.
