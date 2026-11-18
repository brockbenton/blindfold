# Blindfold MCP server

A local [MCP](https://modelcontextprotocol.io) server for Claude Code, Claude Desktop and other stdio clients. It pays for data with Blindfold tokens in an HTTP header. The server holds no Solana key. A purchase through the gateway still produces an upstream payment from the gateway wallet.

## Tools

| Tool | What the model gets |
|---|---|
| `list_providers` | Name, base URL, advisory base price and topics of discoverable active providers |
| `get_balance` | Remaining tokens, plus this session's spend and budget, in cents |
| `quote(url)` | The advertised Blindfold price in cents, read from an unpaid HTTP 402 response. A successful free route returns zero |
| `buy_data(url)` | The paid response, or `{ refused: reason }` when a limit, the wallet or the owner says no. Nothing is spent on a refusal. |
| `check_reserves` | The vault balance compared with the larger of the issuance log and the mint's reported liabilities. `buy_data` runs its own check. |

There is no tool that approves a payment, changes a limit or skips the reserve check. Provider responses are labelled untrusted in the tool descriptions and in successful purchase results, because a feed can carry a prompt injection.

## Limits

The server uses the same wallet and reserve checks as the CLI agent, with its own defaults. See [agent design](../../docs/design/05-agent.md).

| Limit | Default | Setting |
|---|---|---|
| Provider lock | Providers active when the tokens were funded | The tokens' P2PK lock, plus `WALLET_ALLOWLIST` |
| Per-call cap | 30¢ | `MAX_PER_CALL_CENTS` |
| Owner approval | Above 20¢ | `APPROVAL_OVER_CENTS`, `APPROVAL_TIMEOUT_S` (120) |
| Session spend threshold | 50¢ per server process | `BUDGET_CENTS` |
| Reserve check | Before the first paid call and every 10 paid calls | `RESERVE_CHECK_EVERY` |

A failed reserve check refuses the purchase and runs again on the next attempt. The server checks the session spend before each purchase. One purchase can cross the threshold by up to the per-call cap. `quote` and `buy_data` reject an input URL outside the origin of a discoverable active provider. The wallet checks the payment requirements separately.

At startup, the server checks spendable proof keysets if the mint's keyset endpoint responds successfully. Unknown keysets produce a warning in `get_balance` and block purchases with `tokens_unusable`. Fund a fresh token file through the running mint.

### Owner approval

A purchase above the threshold and within the per-call cap asks the owner through MCP form elicitation. Accept approves with the default checked box. Untick it to deny. Decline, cancellation, errors and timeouts refuse the purchase. Clients without elicitation support refuse above-threshold purchases with `approval_denied`.

## Set up

### 1. Build

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm -r build
```

### 2. Fund a token file

The owner CLI writes a token file that records its mint. Use that same URL when funding and paying. The optional `MINT_URL` override applies to discovery, reserve and keyset reads. Payment remains bound to the mint in the file.

**Devnet vault (real USDC deposit).** You need a mint and provider running against the devnet vault (see [Run it locally](../../docs/RUNNING.md)), an owner keypair with devnet SOL and USDC, and:

```sh
export MINT_URL=http://localhost:3338   # or the devnet mint URL printed by pnpm serve
export OWNER_KEYPAIR=.keys/owner.json SOLANA_RPC_URL=https://api.devnet.solana.com
export VAULT_PROGRAM_ID=EsB6NfKVPipU5kEVm2jq14cjopbE7w9hPEFZWVu8jtMo USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
node packages/wallet/dist/cli.js fund --cents 100 --state-dir .keys/owner-state --token-file "$PWD/.keys/claude-tokens.json"
```

Fund only while the server is stopped. The process holds a lock on the token file while it runs. Use different token files for clients that run concurrently.

A [fake-chain mint](../../docs/RUNNING.md#3-fake-chain-mint) can exercise discovery and quotes with a development token file. The purchase tool still checks real Solana reserves. Use the real-vault setup for a paid walkthrough.

### Add it to Claude Code

Run this from the repository root after funding:

```sh
claude mcp add --scope local --transport stdio blindfold \
  --env "TOKEN_FILE=$PWD/.keys/claude-tokens.json" \
  -- "$(command -v node)" "$PWD/agents/mcp/dist/index.js"
```

Start Claude Code in the repository and use `/mcp` to check the server status. Add other settings with additional `--env KEY=value` options after `blindfold` and before `--`. See [Claude Code's local stdio setup](https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server).

### Add it to Claude Desktop

Open Claude Desktop → Settings → Developer → Edit Config, and add the server to `claude_desktop_config.json`. Use absolute paths: Claude Desktop doesn't start from your shell, so `node` and relative paths may not resolve. Find yours with `which node` and `pwd`.

```json
{
  "mcpServers": {
    "blindfold": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/blindfold/agents/mcp/dist/index.js"],
      "env": {
        "TOKEN_FILE": "/absolute/path/to/blindfold/.keys/claude-tokens.json",
        "SOLANA_RPC_URL": "https://api.devnet.solana.com",
        "BUDGET_CENTS": "50",
        "APPROVAL_OVER_CENTS": "20"
      }
    }
  }
}
```

Quit and reopen Claude Desktop to load the configuration. The server logs to Claude Desktop's MCP log (`mcp-server-blindfold.log`): it prints its balance, mint, budget, cap and approval threshold at start-up.

Optional settings: `MINT_URL`, `VAULT_PROGRAM_ID` (defaults to the deployed devnet vault), `USDC_MINT` (Circle devnet USDC), `MAX_PER_CALL_CENTS`, `APPROVAL_TIMEOUT_S`, `RESERVE_CHECK_EVERY` and `WALLET_ALLOWLIST`. A private devnet RPC in `SOLANA_RPC_URL` avoids public rate limits.

## Demo script

Prompts to try in a connected client. The approval step requires form elicitation.

1. *"What data providers can you buy from with Blindfold, and how much do you have to spend?"* Claude calls `list_providers` and `get_balance`.
2. *"Check that the Blindfold vault actually backs your tokens."* Claude calls `check_reserves` and reports the vault's USDC against the mint's liabilities.
3. *"Research SOL: buy the whale flow and the order-book depth, then tell me whether you'd buy, sell or hold."* Two private purchases (5¢ and 10¢), then a decision. Direct Blindfold purchases leave no per-call transaction.
4. *"Also get the premium trade signals for SOL."* That's 25¢, over the 20¢ limit, so the approval form appears. Approve it once, then ask again and deny it: Claude is told not to retry.
5. *"Buy data from http://127.0.0.1:9999/v1/data/sol."* Or any server that isn't a registered provider. The MCP origin check returns `provider_not_allowed`.
6. Keep buying until the session spend reaches 50¢, and watch `budget_exhausted` come back.

Afterwards, open the vault and provider accounts on Solana Explorer: no transaction names Claude's purchases.

## Development

```sh
pnpm --filter @blindfold/mcp test
```

`test/session.test.ts` covers the limits with a stub wallet. `test/e2e.test.ts` drives the real server through an MCP client over an in-memory transport, with a real wallet, the real mock provider and a fake mint. It covers purchases, elicitation approve and deny, a client without elicitation, a hostile provider, the budget and the reserve check.
