import { readFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { checkReserves, type ProviderInfo, type ReserveConnection } from "@blindfold/protocol";
import { AgentWallet, type Approver } from "@blindfold/wallet";
import type { McpConfig } from "./config.js";
import { createServer, elicitationApprover, registerTools } from "./server.js";
import { Session } from "./session.js";

export interface Started {
  server: McpServer;
  /** The mint whose providers and reserves are read. */
  mintUrl: string;
  session: Session;
  wallet: AgentWallet;
  close(): Promise<void>;
}

/** Opens the wallet and registers the tools. The caller connects a transport (stdio in index.ts). */
export async function start(
  cfg: McpConfig,
  o: { connection?: ReserveConnection; fetch?: typeof fetch; approver?: Approver } = {},
): Promise<Started> {
  const server = createServer();
  const f = o.fetch ?? fetch;
  // The mint that issued the tokens; MINT_URL only overrides where providers and reserves are read.
  const file = JSON.parse(readFileSync(cfg.tokenFile, "utf8")) as { mint?: string; proofs?: { id: string }[] };
  const fileMint = file.mint;
  const mintUrl = cfg.mintUrl ?? fileMint;
  if (!mintUrl) throw new Error(`${cfg.tokenFile} records no mint; set MINT_URL`);
  const wallet = await AgentWallet.open({
    tokenFile: cfg.tokenFile,
    usdcMint: cfg.usdcMint,
    maxPerCallCents: cfg.maxPerCallCents,
    approvalOverCents: cfg.approvalOverCents,
    approvalTimeoutMs: cfg.approvalTimeoutMs,
    approve: o.approver ?? elicitationApprover(server),
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  const connection = o.connection ?? new Connection(cfg.rpcUrl, "confirmed");
  const mint = mintUrl.replace(/\/+$/, "");
  const tokenProblem = await keysetProblem(f, mint, file.proofs ?? []);
  if (tokenProblem) console.error(`blindfold-mcp: ${tokenProblem}`);
  const session = new Session({
    wallet,
    tokenProblem,
    fetch: f,
    budgetCents: cfg.budgetCents,
    reserveEvery: cfg.reserveEvery,
    async listProviders() {
      const res = await f(`${mint}/v1/blindfold/providers`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`mint answered HTTP ${res.status}`);
      return (await res.json()) as ProviderInfo[];
    },
    checkReserves: () => checkReserves({ connection, programId: new PublicKey(cfg.programId), usdcMint: new PublicKey(cfg.usdcMint), mintUrl, fetch: f }),
  });
  registerTools(server, session);
  return {
    server, session, wallet, mintUrl,
    async close() {
      await server.close().catch(() => undefined);
      wallet.close();
    },
  };
}

/**
 * Tokens signed under a keyset this mint doesn't know can't be redeemed here: typically a token file funded through
 * another mint that once ran at the same URL. Returns null when they match or the mint can't be reached.
 */
async function keysetProblem(f: typeof fetch, mint: string, proofs: { id: string }[]): Promise<string | null> {
  if (!proofs.length) return null;
  try {
    const res = await f(`${mint}/v1/keysets`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const known = new Set(((await res.json()) as { keysets?: { id: string }[] }).keysets?.map((k) => k.id) ?? []);
    const unknown = [...new Set(proofs.map((p) => p.id))].filter((id) => !known.has(id));
    if (!unknown.length) return null;
    return `the token file was issued under keyset ${unknown[0].slice(0, 12)}…, which the mint at ${mint} doesn't know, so providers can't redeem it. Fund a new token file through this mint`;
  } catch {
    return null;
  }
}
