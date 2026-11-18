import type { Connection, PublicKey } from "@solana/web3.js";
import { decodePaymentResponseHeader } from "@x402/fetch";
import { checkReserves, type ProviderInfo, type ReserveCheckResult } from "@blindfold/protocol";
import { PaymentFailed, type AgentWallet } from "@blindfold/wallet";
import { HttpError, NetworkError } from "./errors.js";
import type { Reporter } from "./reporter.js";

export interface Tools {
  balance(): Promise<{ cents: number }>;
  /** Active providers only. */
  list_providers(): Promise<ProviderInfo[]>;
  call_paid_api(a: { url: string; method?: "GET" | "POST"; body?: unknown }): Promise<{ status: number; data: unknown; paidCents: number; redemptionId?: string }>;
  /** `verified`: liabilities came from the vault's onchain issuance log, not only the mint's report. */
  check_reserves(): Promise<ReserveCheckResult>;
  report(a: { summary: string; data?: unknown }): Promise<void>;
  // No approval tool: owner approval for large purchases is enforced inside the wallet (AgentWallet `approve`),
  // where the price is known and no caller can skip it.
}

export type WalletLike = Pick<AgentWallet, "balance" | "payFetch">;

export interface ToolDeps {
  wallet: WalletLike;
  mintUrl: string;
  connection: Connection;
  programId: PublicKey;
  usdcMint: PublicKey;
  out: Reporter;
  fetch?: typeof fetch;
  /** Stub hooks for --fake and tests. */
  listProviders?: () => Promise<ProviderInfo[]>;
  checkReserves?: Tools["check_reserves"];
}

export function makeTools(d: ToolDeps): Tools {
  const f = d.fetch ?? fetch;
  return {
    async balance() {
      return { cents: d.wallet.balance() };
    },

    async list_providers() {
      if (d.listProviders) return d.listProviders();
      let res: Response;
      try {
        res = await f(`${d.mintUrl.replace(/\/+$/, "")}/v1/blindfold/providers`, { signal: AbortSignal.timeout(10_000) });
      } catch (e) {
        throw new NetworkError(`cannot reach the mint: ${(e as Error).message}`, e);
      }
      if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ""));
      return ((await res.json()) as ProviderInfo[]).filter((p) => p.active);
    },

    async call_paid_api(a) {
      const init: RequestInit = { method: a.method ?? "GET" };
      if (a.body !== undefined) {
        init.body = JSON.stringify(a.body);
        init.headers = { "content-type": "application/json" };
      }
      const before = d.wallet.balance();
      let res: Response;
      try {
        res = await d.wallet.payFetch(a.url, init);
      } catch (e) {
        if (e instanceof PaymentFailed) throw new HttpError(e.status, e.body);
        throw e;
      }
      const paidCents = before - d.wallet.balance();
      const text = await res.text();
      if (!res.ok) throw new HttpError(res.status, text);
      let data: unknown = text;
      try {
        data = JSON.parse(text);
      } catch { /* keep text */ }
      let redemptionId: string | undefined;
      const h = res.headers.get("PAYMENT-RESPONSE");
      if (h) {
        try {
          redemptionId = decodePaymentResponseHeader(h).transaction || undefined;
        } catch { /* header is informational */ }
      }
      return { status: res.status, data, paidCents, redemptionId };
    },

    async check_reserves() {
      if (d.checkReserves) return d.checkReserves();
      return checkReserves({ connection: d.connection, programId: d.programId, usdcMint: d.usdcMint, mintUrl: d.mintUrl, fetch: f });
    },

    async report(a) {
      d.out.log(a.summary);
    },
  };
}
