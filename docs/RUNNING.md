# Run it locally

Run commands from the repository root unless a step says otherwise. Use Node 22+ (Node 24 is also supported), pnpm **10.33.0** from `package.json`, and PostgreSQL. Solana tools are needed for the vault build, local validator runs and deployment. The devnet demo and live stack use the deployed program.

## 1. Install and build

```sh
npx --yes pnpm@10.33.0 install --frozen-lockfile
npx --yes pnpm@10.33.0 -r build
```

Workspace packages resolve through `dist/`, so build before tests and rebuild after source changes. On a cloud machine with a read-only home directory, set `npm_config_cache` to a writable path such as `/workspace/.cache/npm` before using `npx`.

The programs read process environment variables; they do not automatically load `.env`. [`.env.example`](../.env.example) lists baseline settings and development placeholders. Export the values you need in each terminal, or load a local `.env` explicitly (`set -a; . ./.env; set +a`). Replace placeholder secrets and key paths for real-vault use. Use `.keys/` for local key files; that directory is ignored by Git.

## 2. PostgreSQL

Install PostgreSQL server and client tools. The repository supports a user-owned cluster without Docker:

```sh
# Debian/Ubuntu commonly put these tools here; adjust for your installed version.
export PG_BIN=/usr/lib/postgresql/17/bin
export DATABASE_URL="$(services/mint/scripts/dev-pg.sh)"
"$PG_BIN/psql" "$DATABASE_URL" -c 'select 1'
```

`dev-pg.sh` uses `PG_BIN` (default `/usr/bin`), listens on `127.0.0.1:54329`, and stores data in `services/mint/.pgdata/`. It uses local trust authentication for development. Running it again reuses the cluster and database. `DEV_PG_PORT` overrides the port. The stop script also needs the same `PG_BIN`:

```sh
services/mint/scripts/dev-pg-stop.sh
# Add --wipe only to deliberately delete this local cluster and all its databases.
```

Alternatively, with Docker available:

```sh
docker compose up -d postgres
export DATABASE_URL=postgres://blindfold:blindfold@127.0.0.1:5432/blindfold
```

The compose file uses PostgreSQL 16 and creates `blindfold`, not `mint_test`. CI runs the application suite against both PostgreSQL 16 and 18; a local PostgreSQL 17 cluster also works.

Without a system PostgreSQL package (or when the distribution's mirrors can't provide one), a conda-forge build works with the same script:

```sh
conda create -y -n blindfold-pg -c conda-forge postgresql=17
export PG_BIN="$(conda info --base)/envs/blindfold-pg/bin"
export DATABASE_URL="$(services/mint/scripts/dev-pg.sh)"
```

## 3. Fake-chain mint

This mode runs the real mint HTTP server and database with an in-memory vault and settlement sender. No Solana keys or RPC are needed. The vault resets on process restart while PostgreSQL does not: **use a new disposable database and new token file for each fake-chain server session**. Reusing the database can leave deposit cursors, provider records and liabilities inconsistent with the new empty vault.

Starting from the local cluster in section 2, create an isolated demo database:

```sh
export DEMO_DB="blindfold_demo_$(date +%s)_$$"
"$PG_BIN/createdb" --maintenance-db="$DATABASE_URL" "$DEMO_DB"
export DATABASE_URL="postgres://$(id -un)@127.0.0.1:${DEV_PG_PORT:-54329}/$DEMO_DB"
export MINT_URL=http://localhost:3338
export MINT_SEED="$(openssl rand -hex 32)"
export MINT_ADMIN_TOKEN=dev-admin MINT_AUTHORITY_KEYPAIR=unused MINT_DEV_FAKE_CHAIN=1
PORT=3338 node services/mint/dist/index.js
```

The database URL construction above is for `dev-pg.sh`; with Docker or an external database use that server's credentials and a separate demo database. Keep a real mint's seed stable across restarts: boot rejects a seed that disagrees with its stored active keyset.

In another terminal, from the repository root:

```sh
export MINT_URL=http://localhost:3338 MINT_ADMIN_TOKEN=dev-admin
curl --fail "$MINT_URL/v1/info"
npx --yes pnpm@10.33.0 --filter @blindfold/mint exec tsx scripts/smoke.ts
```

The smoke script registers a throwaway provider, deposits, mints, redeems, settles and prints reconciliation totals. Skip it for a fresh provider-0 walkthrough in section 4, or start a new fake-chain session afterwards. It does not test the mock API or an onchain vault. Tests in section 6 cover the application integration.

## 4. Mock API and owner CLI

In another terminal:

```sh
export MINT_URL=http://localhost:3338
export PROVIDER_SECRET_KEY="$(openssl rand -hex 32)"
export PROVIDER_ID=0 PRICE_CENTS=5
PORT=4000 PUBLIC_URL=http://localhost:4000 node apps/mock-api/dist/index.js
```

`GET /health` returns its public key. Register that key at the fake-chain mint:

```sh
export MINT_URL=http://localhost:3338 MINT_ADMIN_TOKEN=dev-admin
export PROVIDER_PUBKEY="$(curl --fail --silent http://localhost:4000/health | node --input-type=module -e 'let s=""; for await (const c of process.stdin) s+=c; console.log(JSON.parse(s).pubkey)')"
curl --fail -X POST "$MINT_URL/dev/provider" \
  -H "authorization: Bearer $MINT_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d "{\"cashu_pubkey\":\"$PROVIDER_PUBKEY\"}"
```

Use the returned `provider_id` for `PROVIDER_ID`; restart the API with the same secret if it differs from 0. The smoke script in section 3 registers a provider too, so an API registered afterwards usually has a later ID. `PROVIDER_ID` is a logging sanity check; the mint credits the signing key, not this variable.

The checked-in `config/providers.json` describes provider 0 at port 4000. If the registered ID differs, supply matching metadata through a separate JSON file and set `PROVIDERS_FILE` when starting the mint. Metadata is loaded at boot. It supplies the URL, topics and advisory price used for agent discovery and denomination planning.

For fake-chain funding (no `OWNER_KEYPAIR`):

```sh
export TOKEN_FILE="$(pwd)/.keys/demo-tokens-$(date +%s).json"
node packages/wallet/dist/cli.js fund --cents 100 --dev-deposit --state-dir .keys/owner-state
node packages/wallet/dist/cli.js balance
node packages/wallet/dist/cli.js providers
```

For the devnet vault, omit `--dev-deposit` and set `OWNER_KEYPAIR`. The owner CLI supplies devnet RPC, program and USDC defaults. Set `SOLANA_RPC_URL`, `VAULT_PROGRAM_ID` and `USDC_MINT` together for another deployment. The owner needs SOL and USDC. Fund only while the agent using that token file is stopped.

On interruption, inspect the saved state in the selected directory. Set `QUOTE_PUBKEY` to the saved filename without `.json`, then resume:

```sh
node packages/wallet/dist/cli.js resume "$QUOTE_PUBKEY" --state-dir .keys/owner-state --dev-deposit
```

Use `--dev-deposit` only for a fake-chain mint. See [recovery limits](design/04-wallet-sdk.md#recovery-limits) before resuming an uncertain real deposit; a persisted checkpoint is not an exactly-once guarantee.

## 5. Agent

A stub-only demonstration needs no services:

```sh
node agents/simple/dist/main.js --fake --json
```

The real agent checks the vault on Solana even when talking to a fake-chain mint. To run against a real localnet or devnet vault, export matching settings and fund the token file first:

```sh
# Export TOKEN_FILE, SOLANA_RPC_URL, VAULT_PROGRAM_ID and USDC_MINT.
# Set MINT_URL if the mint is away from http://localhost:3338.
node agents/simple/dist/main.js --topic sol --calls 3 --json
```

There is no CLI switch to bypass reserves for the fake-chain mint. The PostgreSQL integration suite injects a chain stand-in for that workflow. For Claude clients, follow the [MCP setup](../agents/mcp/README.md#set-up). Exit codes: 2 configuration, 3 payment refused, 4 network, 5 HTTP/payment failure, 6 no provider, 7 reserves failed; 1 is an unexpected error.

## 6. Tests

Use the database from section 2; tests create isolated schemas. With `DATABASE_URL` exported:

```sh
npx --yes pnpm@10.33.0 -r typecheck
npx --yes pnpm@10.33.0 -r test
```

Mint tests require PostgreSQL (defaulting to the dev-pg URL if unset). `tests/integration` skips without `DATABASE_URL`; a successful command with skipped integration tests does not validate the full flow. That suite runs the real mint, provider, owner and agent with a fake chain.

## 7. Real-vault checks

Use Rust 1.89.0 (`rust-toolchain.toml`), Anchor 1.2.2 and Solana tools. If installed in their default locations:

```sh
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.avm/bin:$PATH"
anchor build
cargo test --locked -p vault
npx --yes pnpm@10.33.0 --filter @blindfold/scripts e2e:localnet
```

The Rust integration tests load `target/deploy/vault.so`; `cargo test` alone cannot build that artifact. `anchor test` also runs the configured Cargo tests, but additionally involves Anchor's deployment configuration. Use the direct Cargo command for LiteSVM tests.

The localnet script starts `solana-test-validator` from `$HOME/.local/share/solana/install/active_release/bin`, or reuses an RPC already serving at `127.0.0.1:8899`. Use a fresh validator: the script generates a new mint and keys and expects the vault configuration to match them. It stops only the validator it starts, unless passed `--keep-validator`. Its last section pays the same provider through the x402 `exact` baseline and checks what the competitor bot sees onchain.

The vault's declared ID, `Anchor.toml`, protocol IDL and deployment keypair must agree. The ignored `target/deploy/vault-keypair.json` is not supplied by Git; the deployed program's keypair is kept as `.keys/vault-keypair.json` and copied there before `anchor deploy`. If you generate a new program keypair, synchronize IDs and rebuild before deploying. See [vault deployment notes](design/01-vault.md#10-implementation-notes-and-decisions).

Devnet acceptance:

```sh
npx --yes pnpm@10.33.0 --filter @blindfold/scripts e2e
```

Use this while other settlement writers for the same vault are stopped. The script shares the deployed vault and reconciles its balance change. It requires PostgreSQL, `ADMIN_KEYPAIR`, `OWNER_KEYPAIR` (SOL and at least 1 USDC), and `MINT_AUTHORITY_KEYPAIR` (SOL, matching `Config.mint_authority`). The admin must control the vault to register the test provider. The script deactivates its temporary provider on exit. Set `EXACT_AGENT_KEYPAIR` (USDC) and `EXACT_FACILITATOR_KEYPAIR` (SOL) to include the `exact` baseline section. This spends devnet funds; it is separate from the default test suite.

Reserve checking is strict by default: devnet acceptance fails unless the target vault has an initialized onchain issuance log (the mint initializes it in step 1b if the program supports it) and the agent's reserve check verified liabilities against that log. To accept a program deployed without the issuance log instructions, where agents fall back to the mint's HTTP report, pass `--no-strict-reserves` (`npx --yes pnpm@10.33.0 --filter @blindfold/scripts e2e --no-strict-reserves`) or set `E2E_STRICT_RESERVES=0`. Localnet always requires the log and ignores the option.

## 8. Demo

`npx --yes pnpm@10.33.0 demo` runs the narrated devnet walkthrough with the keys in `.keys/`, and `--localnet` rehearses it on a throwaway validator. See [Run the demo](DEMO.md).

## 9. Live stack (`pnpm serve`)

`npx --yes pnpm@10.33.0 serve` runs Blindfold on this machine against the deployed devnet vault and keeps running until Ctrl-C: PostgreSQL (through `dev-pg.sh` unless `DATABASE_URL` is set), the mint in real chain mode with `.keys/mint-authority.json`, TokenFeed on port 4000 with the standard x402 `exact` baseline (when `.keys/provider-payout.json` and `.keys/facilitator.json` exist), NewsWire on 4001 (once `pnpm demo` has registered it), the [gateway](design/06-gateway.md) on 4100 (once `pnpm gateway:setup` has created its keys and registered it; its devnet stand-in vendor is TokenFeed's `exact` route), and a cloudflared quick tunnel for each so wallets elsewhere can reach them. It prints the public URLs and copy-paste commands to fund a token file and run the agent against them.

Unlike `pnpm demo`, the mint is persistent. Its database lives in the `serve` schema and its seed in `.keys/serve-mint-seed.hex`, with the admin token in `.keys/serve-admin-token`; both files are created on first run, so add them to your key backup. Tokens funded through it keep redeeming across restarts, and settlement runs on the normal schedule (`--window`, default 600 seconds, with a hold of one window and 10-cent units).

| Option | Effect |
|---|---|
| `--local` | Skips quick tunnels. Services advertise localhost unless a `SERVE_*_URL` is set. With a stable mint URL, the same token file works across restarts |
| `--window S` | Settlement window and hold in seconds (10–86,400, default 600) |
| `KEYS_DIR` | Key directory. Defaults to the repository's `.keys/` |
| `SERVE_MINT_URL`, `SERVE_FEED_URL`, `SERVE_NEWS_URL`, `SERVE_GATEWAY_URL` | Your own stable public URLs (for example a named Cloudflare tunnel to ports 3338, 4000, 4001 and 4100); the quick tunnel for that service is skipped |

Quick tunnel URLs change on every run, and a token file only pays the mint URL it was funded through. Use `--local` or `SERVE_MINT_URL` when token files need to outlive one run.

**One settlement writer.** `pnpm serve` and a devnet `pnpm demo` both sign `settle_batch` with the same mint authority. Both acquire `.keys/.settlement-writer.lock` exclusively (or under the shared `KEYS_DIR`). After an unclean exit, check the PID in the lock and remove the file once the writer has stopped. This file does not coordinate different machines or key directories. Coordinate devnet demo, serve and acceptance runs across the team.

The [public vault history](https://brockbenton.github.io/blindfold/vault/) reads deposits, settlements, provider changes and issuance totals from devnet RPC. To serve the page locally, run `python3 -m http.server -d scripts/vault-history` and open `http://localhost:8000`.
