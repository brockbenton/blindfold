# Roadmap

[Delivery plan](plan.md) · [Implemented scope](mvp.md) · [Design](design.md)

This page covers the work after the November 20 submission. The ordering came from an audit of main at `7548a71` (recorded November 17), which we checked against `4a945e0`. Each phase has one exit criterion that can be checked. Nothing here is implemented unless the "Status" column says so.

## Before submission (November 17–20, see [plan](plan.md))

| Work | Status |
|---|---|
| Wallet enforces the remaining session budget for **MCP** (purchases run one at a time; the actual offer price is checked against the remaining budget before any proofs leave) | Done in `4a945e0` |
| Wallet enforces the remaining session budget for the **CLI LLM loop** (`agents/simple/src/llm.ts`) | Done, with a real-wallet test in `agents/simple/test/e2e-local.test.ts` |
| Deterministic Act 6 beat: an allowed provider uses up the session allowance, then the wallet refuses the next valid offer | In progress |
| Run devnet acceptance again, then rehearse and record `pnpm demo` and a backup ([demo](DEMO.md)). Check the revision, data source and RPC in use, reserves provenance, approval outcome and Explorer links before publishing a replay | November 18–19 |

## After submission

Each phase is roughly one week.

### Phase 1: Reproducible reserves

**Why:** the issuance log makes published issuance harder to retract. Separate chain reads plus a mint HTTP report can still give an ambiguous snapshot.

- Strict acceptance mode: devnet acceptance fails when the target has no initialized issuance log. Local-validator acceptance already requires it as of `4a945e0`.
- A snapshot on `/vault/` that machines can read. Chain accounts are read in a shared RPC context, and the snapshot shows the slot, where the claim came from, the coverage margin and any incomplete history.
- A controlled fixture where the mint's HTTP report is lower than an onchain claim the vault can't cover. Acceptance must refuse it. Today this is only covered at unit level in `packages/protocol/test/reserves.test.ts`.

**Exit:** a viewer can independently recover the balance, the logged claim, the observation slot and the coverage verdict.

**Limits to state:** the mint still holds signing and settlement authority and can issue outside the log.

### Phase 2: Privacy benchmark with the same workload

**Why:** "no per-call chain transfer" is the central claim, but how well an observer can attribute purchases also depends on seller memos, funding patterns and how much of the chain the observer actually sees.

- Replay one seeded set of purchases under tagged `exact`, nonce-only `exact` and Blindfold.
- Report per-call transfers and attributions (correct, incorrect, abstained) against known ground truth. The ground truth stays out of what the observer sees.
- Cases: equal deposits, skewed deposits, older unspent tokens, several payout windows.
- Treat incomplete capture as an inconclusive result, not a success.

**Exit:** the replay's evidence panel reports attribution accuracy and coverage for each case.

### Phase 3: Agent safety, part two

- Count pending value conservatively against the budget, and release it once checkstate proves the proofs unspent.
- Test parallel MCP calls, variable prices, and a paid response lost in transit.
- **Funding tokens for selected providers:** `ownerFund` currently locks tokens to every active provider. The lock parser already accepts any subset. Add an owner option for a provider group, and show that a provider outside the group cannot redeem the tokens.

**Exit:** a too-large final offer, parallel requests and a lost paid response can't push spending past the authorized session amount, and wallet and provider balances confirm it.

### Phase 4: Recoverable delivery and a provider adapter

- **Recoverable delivery on one gateway route.** As of `4a945e0` the gateway buys upstream once and logs a failure as "owed". Next: a durable delivery record, privately tied to the mint redemption, plus a retrieval ID the client knows before paying. The client can fetch a completed response after a disconnect. Don't make another paid attempt without evidence the upstream purchase didn't go through. Keep stored records only briefly, because they link a payment to a query.
- **Provider adapter.** Package a thin Hono adapter (currently shared through mock-api's workspace exports) and use it for one independently configured route that serves both schemes. Run the acceptance tests with the stock `exact` client and with the Blindfold wallet.

**Exit:** after a controlled disconnect, the client retrieves the completed response without being charged twice. The integration contract documents what a provider has to configure.

### Ops hardening (fit in alongside the phases)

- **Settlement crash recovery:** save the prepared transaction signature before broadcasting, as the issuance job already does. On recovery, confirm the stored signature or match the actual payout record; don't rely on `lastBatchId` alone. Flag ambiguous batches for reconciliation. Some of this changed in `4a945e0`, so re-audit before building.
- **Safe retries for owner top-ups:** record the signed deposit attempt before broadcasting and treat a failed RPC lookup as unresolved, not as "absent". Record when a funding operation has been added to the token file. Test the process dying after broadcast and after appending proofs.
- **Provider retirement check:** before deactivating a provider, report its payable, held, in-flight and sub-unit balances, and drain them to the registered destination. Inactive providers can't be paid today.

### Later, once the phases above are in

- One independently operated `exact` upstream behind the gateway, with its network, asset, payee and cap configured explicitly. `apps/gateway/src/index.ts` currently hardcodes devnet for the upstream side.
- Owner co-signature for reserve funds. Start with a reserve file held separately before changing the proof format.
- Standard funding amounts in the owner CLI with cohort context, if the Phase 2 benchmark shows they help.
- One opt-in two-hop relay experiment to measure what IP and query metadata a provider sees.
- Show in quotes whether a route is currently payable ("insufficient exact change"). Measure how much value ends up stranded before designing swap.

## Not doing

| Item | Why |
|---|---|
| Mainnet as the next milestone | It raises the cost of the same custody, signer and recovery weaknesses. An independent devnet provider answers the adoption question sooner. |
| Fresh payout addresses under the existing registry | Registering a fresh destination publicly reveals the link again. Allowing arbitrary destinations widens the mint's power over vault funds. |
| Multiple mint operators, onchain escape hatch | Expands the custody and coordination model before reserves, recovery and provider adoption are proven. |
| General Cashu swap, melt, or standard wallet support | Provider restrictions and USDC custody are exactly what an unrestricted implementation would weaken. Melt adds new payout authority. |
| Hidden provider revenue | Fixed windows, hold periods and rounding already ship. Unlinking payout destinations needs a new authorization design. |
| A full public view of the mint's books | Would disclose redemption activity, and completeness would still depend on the mint. |
| Temporal as the fix for duplicate charges | A durable scheduler can repeat activities. Retries need to be safe first (see Ops hardening). |
| Key rotation | Deferred. It needs a funded migration and a retirement process. |
| A stronger model or flashier Copycat animation as the safety proof | The evidence we're missing is a hard bound against an allowed recipient, plus measured observer accuracy. |
