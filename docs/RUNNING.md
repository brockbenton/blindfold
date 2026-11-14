# Run it locally

Prereqs: Node 22+ (26 used), pnpm (`npx -y pnpm@10` works), Postgres. Solana tools for localnet: prefix commands with
`export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.avm/bin:$PATH"`.

```sh
npx -y pnpm@10 install
npx -y pnpm@10 -r build          # workspace packages resolve each other through dist/
```

## 1. Postgres

```sh
services/mint/scripts/dev-pg.sh          # no docker; port 54329, prints DATABASE_URL
export DATABASE_URL=postgres://$USER@127.0.0.1:54329/blindfold
# or: docker compose up -d postgres  (postgres://blindfold:blindfold@localhost:5432/blindfold)
services/mint/scripts/dev-pg-stop.sh     # stop (add --wipe to delete data)
```

## 2. Mint

Fake chain (no Solana; in-memory vault, fake settlement sender, `/dev/*` hooks):

```sh
export MINT_SEED=$(openssl rand -hex 32) MINT_ADMIN_TOKEN=dev-admin MINT_AUTHORITY_KEYPAIR=unused
MINT_DEV_FAKE_CHAIN=1 npx -y pnpm@10 --filter @blindfold/mint dev     # :3338
MINT_URL=http://localhost:3338 MINT_ADMIN_TOKEN=dev-admin npx -y pnpm@10 --filter @blindfold/mint exec tsx scripts/smoke.ts   # mint-only walkthrough
```

Real vault (localnet or devnet): leave `MINT_DEV_FAKE_CHAIN` unset and set `SOLANA_RPC_URL`, `VAULT_PROGRAM_ID`, `USDC_MINT`,
`MINT_AUTHORITY_KEYPAIR` (must equal `Config.mint_authority`). For localnet, start the validator and set the vault up first (section 7).

## 3. Mock API (provider)

```sh
export PROVIDER_SECRET_KEY=$(openssl rand -hex 32) PROVIDER_ID=0 PRICE_CENTS=5 PORT=4000 MINT_URL=http://localhost:3338
npx -y pnpm@10 --filter mock-api start        # prints its Cashu pubkey
```

Register that pubkey as a provider: fake chain `curl -X POST localhost:3338/dev/provider -H 'authorization: Bearer dev-admin' -H 'content-type: application/json' -d '{"cashu_pubkey":"<pubkey>"}'`;
real vault `ADMIN_KEYPAIR=... node --experimental-strip-types scripts/devnet/register-provider.ts <pubkey> <payoutTokenAccount>`.
Put its `url` and `topics` in `config/providers.json` (the agent finds providers through the mint).

## 4. Owner funds a token file

The owner CLI deposits on Solana (`SolanaDepositor`), so it needs a real vault (localnet or devnet):

```sh
export OWNER_KEYPAIR=./keys/owner.json TOKEN_FILE=./tokens.json SOLANA_RPC_URL=... VAULT_PROGRAM_ID=... USDC_MINT=...
node packages/wallet/dist/cli.js fund --cents 100
node packages/wallet/dist/cli.js balance
```

With the fake chain, fund through the test harness instead (it swaps the depositor for `/dev/deposit`): section 6.

## 5. Agent

```sh
TOKEN_FILE=./tokens.json MINT_URL=http://localhost:3338 SOLANA_RPC_URL=... VAULT_PROGRAM_ID=... USDC_MINT=... \
  node agents/simple/dist/main.js --topic sol --calls 3          # add --json for one JSON line
node agents/simple/dist/main.js --fake                            # no mint, chain or provider
```

Exit codes: 3 refused (allowlist, cap), 7 reserve check failed (fails closed), 4 network, 5 http.

## 6. Tests

```sh
npx -y pnpm@10 -r typecheck && npx -y pnpm@10 -r test
```

Mint and integration tests need Postgres (`DATABASE_URL`; mint tests default to the dev-pg URL, integration tests skip without it).
`tests/integration` boots the real mint (fake chain), real mock API, real owner flow and real agent in one process.

## 7. Localnet end to end (real vault)

```sh
anchor build                                   # target/deploy/vault.so; keep target/deploy/vault-keypair.json (never commit it)
export DATABASE_URL=postgres://$USER@127.0.0.1:54329/blindfold
npx -y pnpm@10 --filter @blindfold/scripts e2e:localnet
```

The script starts `solana-test-validator` with the program loaded (or reuses one on :8899), creates a 6-decimal mint as fake USDC,
initializes the vault, registers a provider, then runs 00 section 10: deposit, mint, paid call, replay, settle, reconcile, fail-closed
reserve check. It stops the validator when done (`--keep-validator` to leave it). The program id must match the keypair
(`3nVcHrZ9PC2kEPGYxvqedudeCfHXtZj1BRzwfxWqAanT`).

Devnet: `npx -y pnpm@10 --filter @blindfold/scripts e2e` with `ADMIN_KEYPAIR`, `OWNER_KEYPAIR` (SOL plus 1 USDC), `MINT_AUTHORITY_KEYPAIR`
(SOL), and a deployed vault. Details in the header of `scripts/e2e.ts`.
