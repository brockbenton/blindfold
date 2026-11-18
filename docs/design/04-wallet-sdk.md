# 04: Wallet SDK and owner CLI

`packages/wallet/` contains the agent wallet and the owner's funding client. Both use the [shared interfaces](00-interfaces.md). [Runbook](../RUNNING.md#4-mock-api-and-owner-cli).

## Agent wallet API

```ts
const wallet = await AgentWallet.open({
  tokenFile, maxPerCallCents: 10,
  // Optional: allowlist, usdcMint, fetch, mint (checkstate client), now,
  // approvalOverCents (20), approve (an Approver), approvalTimeoutMs (60 000).
});
try {
  wallet.balance();        // spendable cents
  wallet.pendingBalance();// unresolved cents
  wallet.proofCount();
  const response = await wallet.payFetch(url);
} finally {
  wallet.close();          // release the token-file lock
}
```

`open()` loads the file, acquires its lock and reconciles pending proofs. Defaults come from `TOKEN_FILE`, `MAX_PER_CALL_CENTS`, `WALLET_ALLOWLIST` and `USDC_MINT` through the protocol loaders. Without a configured allowlist, it uses the union of signer sets in spendable and pending proofs.

`payFetch` wraps `@x402/fetch`, registering only `blindfold` on the devnet CAIP-2 identifier. It does not pay `exact` schemes. Mint URL matching normalizes scheme/host and trailing path slashes while preserving case-sensitive paths and query strings; different tenants on one host are not interchangeable. It returns unpaid non-402 responses unchanged. For a payment attempt, a non-2xx final response raises `PaymentFailed` after recovery; pre-payment refusals raise `PaymentRefused`. Network exceptions propagate after recovery. Stream request bodies are refused because they cannot be replayed.

`PaymentRefused.reason` is one of `bad_request`, `unit`, `mint`, `over_cap`, `provider_not_allowed`, `provider_not_in_signer_set`, `insufficient_exact`, `insufficient_balance`, `approval_denied` or `approval_timeout`. Spend controls may reject the asset or cap before the scheme runs; the wrapper maps those SDK errors to the wallet's reasons. `PaymentFailed` carries status, body, recovered **cent amounts** and an optional reason. In the current mock API, failed settlement returns `402 {}` and does not expose the underlying reason.

## Owner approval

A price above `approvalOverCents` (default 20, or `APPROVAL_OVER_CENTS` when `open()` reads the environment) needs the owner's approval. The check runs in `CashuClientScheme.createPaymentPayload`, after the unit, mint, cap, provider and exact-selection checks and before proofs move to `pending`, so a refusal leaves the token file unchanged. The price is the one in the provider's 402 challenge; the agent above the wallet never has to know it. [Why the wallet](05-agent.md#owner-approval).

```ts
type Approver = (req: ApprovalRequest, signal: AbortSignal) => Promise<boolean>;
// req: { id, cents, url (origin + path), provider (hex33), thresholdCents, timeoutMs }
```

`askApproval` races the approver against `approvalTimeoutMs`, then aborts `signal`. `true` pays; `false`, a non-boolean, a thrown error or no approver refuses with `approval_denied`; no answer in time refuses with `approval_timeout`. The wallet's spend mutex is held while waiting, so payments stay sequential.

| Helper | Behavior |
|---|---|
| `terminalApprover({ input, output, format })` | Prompts once; `y` or `yes` approves, anything else denies |
| `approvalBroker({ onRequest, onDone })` | Keeps pending requests for a UI; `resolve(id, ok)` answers one and returns false if it is no longer pending. `onDone` reports `approved`, `denied` or `timeout` |
| `anyApprover(...approvers)` | The first answer wins; the others are aborted with that outcome |
| `fixedApprover(ok)` | Always the same answer, for tests and unattended runs |

## Token storage and payment state

The JSON format has `version: 1`, `mint`, `unit: "usd"`, `proofs`, and optional `pending: [{proofs, url, sent_at}]`. Stored amounts are numbers; witnesses are stripped. Reads preserve unknown top-level fields and keep the first occurrence of each secret across spendable and pending entries.

Writes use a same-directory temporary file, file `fsync` and rename, with mode 0600. `AgentWallet.open` takes `<file>.lock` containing the PID. A live PID blocks another wallet; a dead PID's lock can be replaced. Locks do not expire after an arbitrary age. One wallet process per file is supported. The owner takes the same lock only while appending minted proofs. If an agent holds it, funding stops after minting and tells you to stop the agent and run `owner resume`. Do not run concurrent funding operations on the same file.

| Payment stage | Persisted action |
|---|---|
| Select | Choose exact proofs; no mutation yet |
| Before sending | Move selected proofs to `pending` and write |
| Successful settlement response | Remove pending proofs and write |
| Failure, missing response or paid-retry exception | Ask the mint for NUT-07 checkstate |
| Checkstate says `UNSPENT` | Return proofs to spendable balance |
| Checkstate says `SPENT` | Drop proofs |
| `PENDING`, missing state or failed checkstate | Keep proofs pending |

A mutex serializes `payFetch` and explicit recovery inside one wallet. The wallet never blindly restores unknown proofs or automatically repays a failed call. Losing a paid response can mean tokens were spent without data being delivered.

## Exact-sum selection

`selectExact` operates on `WireProof[]`, filters to signer sets containing the provider key and denominations no larger than the price, then uses subset-sum dynamic programming. It prefers fewer proofs and uses secret ordering to break ties deterministically. If the usable denominations total less than the target it returns `insufficient_balance`; if enough value exists but no exact subset does, it returns `insufficient_exact`.

There is no swap or change. `planDenominations` assigns 80% of the funding amount to repeated binary bundles for distinct expected prices, with a remainder ladder `1,1,2,2,4,4,…` and a binary tail. It filters invalid/out-of-budget prices and falls back to `min(5, cents)`. Every denomination must be a supported power of two and the sum must equal the deposit.

For 100 cents at price 5, the plan has sixteen `4+1` bundles and a 20-cent remainder: `1,1,2,2,4,4,4,2`, giving 40 proofs. This helps expected prices remain payable; it does not guarantee arbitrary price changes remain payable after spending. Plans above 256 outputs are minted in separately signed chunks.

## Owner funding

`ownerFund` takes `{mintUrl, cents, tokenFile, depositor}` plus optional `prices`, `stateDir`, polling/timeout settings and injected clients. `prices` affects denomination planning, never the token lock. All active provider keys are deduplicated, lowercased and sorted into one global 1-of-N lock. A narrower `WALLET_ALLOWLIST` is an agent policy, not a narrower cryptographic lock.

1. Fetch providers and reject an empty active set. Build the denomination plan.
2. Generate and persist a quote key before requesting the quote. Check its returned key, amount and deposit reference.
3. Deposit through `SolanaDepositor` or the development-only `DevDepositor`, then persist the returned transaction identifier.
4. Poll until `amount_paid - amount_issued >= cents`. Once outputs have been saved, resume can skip this wait and replay mint requests.
5. Fetch keys, create blinded P2PK outputs and persist secrets/blinding factors before minting.
6. Sign each request with NUT-20. Retry network/5xx failures up to three times with identical outputs; definite 4xx responses are final.
7. Unblind and verify DLEQ, total amount and signer sets. Append verified proofs to the matching mint's token file, then delete the recovery state.

Funding always plans the requested amount. Extra deposits to the quote do not automatically enlarge it or trigger a refund. Recovery state defaults to `~/.blindfold/owner/<quote-pubkey>.json`, mode 0600; it includes the quote secret and blinding material and must be protected.

### Recovery limits

Resume skips a deposit **when `depositTx` was successfully persisted**. It is not an exactly-once guarantee: a transaction can land before its result is saved, and a confirmation timeout can leave its outcome uncertain. `SolanaDepositor` rebuilds and resends, up to three attempts, only when an earlier attempt provably moved no funds (preflight rejection, onchain failure, or blockhash expiry without landing). An undetermined outcome throws with the signature instead. Inspect the chain and quote state before resuming an uncertain deposit; a duplicate deposit is possible and has no refund path.

A crash after the token file is written but before recovery-state removal also needs inspection before resuming, because the state may still describe proofs already appended. Keep the agent stopped during recovery so the final write can take the token-file lock. The current files are checkpoint recovery for a prototype, not a durable distributed transaction protocol.

Fake-chain mint memory resets on restart. Use a fresh database, token file and recovery session after restarting it; saved tokens and funding checkpoints from its previous in-memory vault should not be treated as a new funded session.

## CLI

Run built commands from the repository root, for example `node packages/wallet/dist/cli.js balance`. The workspace also exposes the `owner` bin after building/relinking dependencies.

| Command | Behavior |
|---|---|
| `fund --cents N [--prices 5,3] [--token-file F] [--state-dir D]` | Real-vault funding using `OWNER_KEYPAIR`; defaults to 10-minute polling timeout |
| `fund … --dev-deposit` | Fake-chain mint's admin-protected `/dev/deposit`; needs `MINT_ADMIN_TOKEN`, no owner key |
| `resume <quote-pubkey> [--state-dir D] [--dev-deposit]` | Load checkpoint and continue; same deposit mode and directory as the original funding run |
| `balance [--token-file F]` | Spendable/pending cents and count per denomination |
| `providers` | List active and inactive providers known to the mint |

For fake-chain resume, `MINT_URL` must still point to that session's mint so the development depositor reaches it. Real funding requires `OWNER_KEYPAIR`. RPC, program ID and USDC mint default to the devnet deployment. Override them together for another vault. Node processes do not load `.env` automatically. CLI errors exit nonzero with a one-line message.

## Source and tests

`agent-wallet.ts`, `cashu-scheme.ts`, `approval.ts`, `select.ts`, `store.ts`, `checkstate.ts` and `mutex.ts` implement spending. `owner.ts`, `denominations.ts`, `depositor.ts`, `dleq.ts` and `cli.ts` implement funding. `tool.ts` exposes a thin `payFetchTool` wrapper; the LLM loop lives in the agent, and owner co-signing is not implemented.

Tests in `test/` use HTTP fakes and real Cashu crypto for funding, DLEQ rejection, mint-response replay, checkpoint resume, selection, locks, concurrency, pending recovery and owner approval. `runCli(argv, deps)` injects a depositor for tests; there is no test-only depositor environment flag or `SOLANA_TEST=1` suite. The application integration tests use the real mint with PostgreSQL and a fake chain. Real Solana deposit/settlement validation is the separate [real-vault acceptance workflow](../RUNNING.md#7-real-vault-checks).
