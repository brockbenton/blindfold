import { USDC_DEVNET_MINT } from "@blindfold/protocol";

/** The deployed devnet vault (docs/design/01-vault.md, section 10). */
export const DEVNET_VAULT_PROGRAM_ID = "EsB6NfKVPipU5kEVm2jq14cjopbE7w9hPEFZWVu8jtMo";

export interface McpConfig {
  tokenFile: string;
  /** Defaults to the mint recorded in the token file. */
  mintUrl?: string;
  rpcUrl: string;
  programId: string;
  usdcMint: string;
  maxPerCallCents: number;
  approvalOverCents: number;
  approvalTimeoutMs: number;
  budgetCents: number;
  reserveEvery: number;
}

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined>): McpConfig {
  const v = (k: string) => (env[k] === undefined || env[k] === "" ? undefined : env[k]);
  const int = (k: string, def: number, min: number) => {
    const n = v(k) === undefined ? def : Number(v(k));
    if (!Number.isInteger(n) || n < min) throw new ConfigError(`${k} must be an integer >= ${min}`);
    return n;
  };
  const tokenFile = v("TOKEN_FILE");
  if (!tokenFile) throw new ConfigError("TOKEN_FILE is required: the token file written by the owner CLI (`fund`)");
  return {
    tokenFile,
    mintUrl: v("MINT_URL"),
    rpcUrl: v("SOLANA_RPC_URL") ?? "https://api.devnet.solana.com",
    programId: v("VAULT_PROGRAM_ID") ?? DEVNET_VAULT_PROGRAM_ID,
    usdcMint: v("USDC_MINT") ?? USDC_DEVNET_MINT,
    maxPerCallCents: int("MAX_PER_CALL_CENTS", 30, 1),
    approvalOverCents: int("APPROVAL_OVER_CENTS", 20, 0),
    approvalTimeoutMs: int("APPROVAL_TIMEOUT_S", 120, 1) * 1000,
    budgetCents: int("BUDGET_CENTS", 50, 1),
    reserveEvery: int("RESERVE_CHECK_EVERY", 10, 1),
  };
}
