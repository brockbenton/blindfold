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
  const fileMint = (JSON.parse(readFileSync(cfg.tokenFile, "utf8")) as { mint?: string }).mint;
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
  const session = new Session({
    wallet,
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
