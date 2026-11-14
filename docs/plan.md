# Blindfold: Plan

When we build it. Scope is in [`mvp.md`](mvp.md), design in [`design.md`](design.md).

## Week plan

| Day | Work |
|---|---|
| **Thu Nov 12** (kickoff night) | Spikes: BDHKE round trip and a NUT-11 locked token with `cashu-ts`; a devnet USDC deposit into an Anchor program; a standard x402 call on Solana devnet; a QuickNode Stream firing a webhook |
| **Fri** | Vault (`deposit`, `register_provider`, `settle_batch`) + mint (sign, redeem, spent set) |
| **Sat** | Mock paid API + wallet SDK; first paid call |
| **Sun** | Replay rejection, `settle_batch` payout, simple agent. **MVP done** |
| **Mon** | Add-on 1: baseline x402 path, competitor bot, split screen |
| **Tue** | Add-on 2: allowlist locks + injection beat. Add-on 3: QuickNode Stream |
| **Wed** | Add-ons 4–7 as time allows; README |
| **Thu Nov 19** | Demo video + recorded backup |
| **Fri Nov 20** | Submit before 12:00 PM CST |

**Sat Nov 21:** must attend the closing ceremony in person.

## Repo layout

```
programs/vault/        Anchor program
services/mint/         mint (+ Temporal workers, add-on 5)
packages/middleware/   provider NUT-24 middleware
packages/wallet/       agent wallet SDK
agents/research/       agent
agents/competitor/     demo adversary (add-on 1)
apps/providers/        mock paid APIs
apps/view/             split screen (add-on 1)
```

## Risks

- **"Isn't this a mixer?"** Lead with the [not-a-mixer rules](design.md#trust-and-not-a-mixer).
- **"Privacy for whom?"** Real x402 volume is tiny (about $28k/day in March 2026, roughly half wash trading). Answer with the Linux Foundation standard and Circle building privacy into Arc. Teams that subscribe to their main vendors already get much of this privacy through ordinary billing; demand for this payment method is unproven.
- **"Why not fresh wallets?"** Curvy's approach covers part of the need cheaply. Ecash adds an untraceable funding source, an operator who can't link payments, no gas per call, and rules in the tokens.
- **Judges may know bigrceo/hush.** Lead with the competitor table: operator-blind plus guardrails in the tokens.
- **Privacy is thin with 2 agents.** The bot makes it concrete; say plainly that privacy grows with users.
- **Overclaiming on security.** Follow [`security-sources.md`](security-sources.md#how-we-use-this): the drain flaw is patched in code but not in structure, and we never claim to fix x402 security in general.
- **Scope:** about 10 components. Follow the cut order in [`mvp.md`](mvp.md#add-ons).

## Open questions

- [ ] Which NUTs does `cashu-ts` support (10/11/12/24)?
- [ ] Facilitator for the baseline x402 path on Solana devnet? (Baseline only; Blindfold itself uses no third-party facilitator.)
- [ ] Add-on 7: hide provider revenue at the cost of moving the provider registry offchain?
