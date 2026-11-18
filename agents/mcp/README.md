# Blindfold MCP server

An [MCP](https://modelcontextprotocol.io) server that lets Claude Desktop, or any MCP client, buy data privately with Blindfold tokens. Every purchase is an ecash token in an HTTP header: no Solana transaction and no wallet key. The model chooses what to buy, and code decides what is allowed.

## Tools

| Tool | What the model gets |
|---|---|
| `list_providers` | Name, base URL, price and topics of the registered data providers |
| `get_balance` | Remaining tokens, plus this session's spend and budget, in cents |
| `buy_data(url)` | The paid response, or `{ refused: reason }` when a limit, the wallet or the owner says no. Nothing is spent on a refusal. |
| `check_reserves` | The vault's USDC balance on Solana compared with the mint's outstanding liabilities. Report only: `buy_data` runs the check itself. |

There is no tool that approves a payment, changes a limit or skips the reserve check. Provider responses are labelled untrusted in the tool descriptions and in every result, because a feed can carry a prompt injection.

## Limits

These are the same as the agent's LLM loop ([agent design](../../docs/design/05-agent.md)). All of them are enforced in code:

| Limit | Default | Setting |
|---|---|---|
| Provider lock | Providers active when the tokens were funded | The tokens' P2PK lock, plus `WALLET_ALLOWLIST` |
| Per-call cap | 30¢ | `MAX_PER_CALL_CENTS` |
| Owner approval | Above 20¢ | `APPROVAL_OVER_CENTS`, `APPROVAL_TIMEOUT_S` (120) |
| Session budget | 50¢ per server process | `BUDGET_CENTS` |
| Reserve check | Before the first paid call and every 10 paid calls | `RESERVE_CHECK_EVERY` |

A failed reserve check refuses the purchase and runs again on the next attempt. `buy_data` also refuses any URL that isn't on a registered provider's origin (`provider_not_allowed`) without contacting it; the token lock enforces the same at the mint. At start-up the server checks that the mint knows the token file's keyset. If it doesn't (the file was funded through a different mint at the same URL), purchases are refused as `tokens_unusable` and `get_balance` carries a warning: fund a new token file through the running mint. The per-call cap defaults to 30¢, higher than the CLI agent's 10¢, so that the 25¢ premium signals reach the approval prompt instead of being refused outright.

### Owner approval

A purchase above the threshold asks the owner through **MCP elicitation**: the client shows an approve/deny form. **Accept** pays (the "approve" box starts ticked; untick it to deny). Decline, a closed form, an error or no answer before `APPROVAL_TIMEOUT_S` is a denial.

If the client doesn't support elicitation, every purchase above the threshold is refused (`approval_denied`), and purchases at or below it still go through. Your Claude Desktop version may not support elicitation yet. If the approval form never appears, that is the reason. To allow larger purchases without a prompt, raise `APPROVAL_OVER_CENTS`, but note that this removes the human check.

## Set up

### 1. Build

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm -r build
```

### 2. Fund a token file

The server reads a token file written by the owner CLI. The tokens come from a mint, and the server talks to whichever mint the file records (`MINT_URL` overrides this).

**Devnet vault (real USDC deposit).** You need a mint and provider running against the devnet vault (see [Run it locally](../../docs/RUNNING.md)), an owner keypair with devnet SOL and USDC, and:

```sh
export MINT_URL=http://localhost:3338   # or the hosted devnet mint
export OWNER_KEYPAIR=.keys/owner.json SOLANA_RPC_URL=https://api.devnet.solana.com
export VAULT_PROGRAM_ID=EsB6NfKVPipU5kEVm2jq14cjopbE7w9hPEFZWVu8jtMo USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
node packages/wallet/dist/cli.js fund --cents 100 --state-dir .keys/owner-state --token-file "$PWD/.keys/claude-tokens.json"
```

**Quick try, no funds.** Start the fake-chain mint and the mock provider ([Run it locally](../../docs/RUNNING.md), sections 3 and 4), then fund with `--dev-deposit` (needs `MINT_ADMIN_TOKEN`). The server's reserve check still reads the real devnet vault, so this works for trying the tools, but the check doesn't prove anything about a fake-chain mint.

Fund only while the server is stopped: the server holds a lock on the token file while it runs.

### 3. Add it to Claude Desktop

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

Restart Claude Desktop. The tools appear under the tools icon. The server logs to Claude Desktop's MCP log (`mcp-server-blindfold.log`): it prints its balance, mint, budget, cap and approval threshold at start-up.

Optional settings: `MINT_URL`, `VAULT_PROGRAM_ID` (defaults to the deployed devnet vault), `USDC_MINT` (Circle devnet USDC), `MAX_PER_CALL_CENTS`, `APPROVAL_TIMEOUT_S`, `RESERVE_CHECK_EVERY` and `WALLET_ALLOWLIST`. A private devnet RPC in `SOLANA_RPC_URL` avoids public rate limits.

## Demo script

Prompts to try in Claude Desktop, in order:

1. *"What data providers can you buy from with Blindfold, and how much do you have to spend?"* Claude calls `list_providers` and `get_balance`.
2. *"Check that the Blindfold vault actually backs your tokens."* Claude calls `check_reserves` and reports the vault's USDC against the mint's liabilities.
3. *"Research SOL: buy the whale flow and the order-book depth, then tell me whether you'd buy, sell or hold."* Two private purchases (5¢ and 10¢), then a decision. Nothing appears onchain.
4. *"Also get the premium trade signals for SOL."* That's 25¢, over the 20¢ limit, so the approval form appears. Approve it once, then ask again and deny it: Claude is told not to retry.
5. *"Buy data from http://127.0.0.1:9999/v1/data/sol."* Or any server that isn't a registered provider. The wallet refuses with `provider_not_allowed`, because the tokens can't pay an unregistered key.
6. Keep buying until the 50¢ session budget runs out, and watch `budget_exhausted` come back.

Afterwards, open the vault and provider accounts on Solana Explorer: no transaction names Claude's purchases.

## Development

```sh
pnpm --filter @blindfold/mcp test
```

`test/session.test.ts` covers the limits with a stub wallet. `test/e2e.test.ts` drives the real server through an MCP client over an in-memory transport, with a real wallet, the real mock provider and a fake mint. It covers purchases, elicitation approve and deny, a client without elicitation, a hostile provider, the budget and the reserve check.
