# Blindfold: Plan

How we build it. Scope is in [`mvp.md`](mvp.md), design in [`design.md`](design.md), build briefs in [`design/`](design/00-interfaces.md).

## Dates

| When | What |
|---|---|
| Sun Nov 15 to Wed Nov 18 | Build |
| Thu Nov 19 | Demo video + recorded backup |
| Fri Nov 20, 12:00 PM CST | Submit |
| Sat Nov 21 | Closing ceremony, in person |

## Build order

1. **Together:** `packages/protocol` from [`design/00-interfaces.md`](design/00-interfaces.md) §8, plus toolchain setup (Solana CLI, Anchor 1.2.2, Postgres).
2. **In parallel**, each against the contract and its own stubs:
   - Vault ([`01-vault.md`](design/01-vault.md))
   - Mint ([`02-mint.md`](design/02-mint.md))
   - Mock API, wallet SDK, agent ([`03`](design/03-mock-api.md), [`04`](design/04-wallet-sdk.md), [`05`](design/05-agent.md))
3. **Integrate** on devnet until the acceptance script in 00 §10 passes. That is MVP done.
4. **Add-ons** in the order in [`mvp.md`](mvp.md#add-ons).

Repo layout: 00 §9.

## Risks

- **"Isn't this a mixer?"** Lead with the [not-a-mixer rules](design.md#trust-and-not-a-mixer).
- **"Privacy for whom?"** Real x402 volume is tiny (about $28k/day in March 2026, roughly half wash trading). Answer with the Linux Foundation standard and Circle building privacy into Arc. Teams that subscribe to their main vendors already get much of this privacy through ordinary billing; demand for this payment method is unproven.
- **"Why not fresh wallets?"** Curvy's approach covers part of the need cheaply. Ecash adds an untraceable funding source, an operator who can't link payments, no gas per call, and rules in the tokens.
- **Judges may know x402 `batch-settlement` on Solana.** It also deposits once and settles in batches. Answer: its channels are public per payer and provider, the agent holds a signing key, and it needs one funded channel per provider.
- **Judges may know bigrceo/hush.** Lead with the competitor table: operator-blind plus guardrails in the tokens.
- **Privacy is thin with 2 agents.** The bot makes it concrete; say plainly that privacy grows with users.
- **Overclaiming on security.** Follow [`security-sources.md`](security-sources.md#how-we-use-this): the drain flaw is patched in code but not in structure, and we never claim to fix x402 security in general.
- **Scope:** about 10 components. Follow the cut order in [`mvp.md`](mvp.md#add-ons).

## Open questions

- [ ] Add-on 7: hide provider revenue at the cost of moving the provider registry offchain?
