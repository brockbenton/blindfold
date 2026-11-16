// Baseline for comparison: the standard x402 `exact` scheme on Solana (@x402/svm). Every paid call is its own public
// USDC transfer from the payer's wallet to the provider. Blindfold's `cashu` routes are unaffected.
import { readFileSync } from "node:fs";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorClient } from "@x402/core/http";
import { toFacilitatorSvmSigner, type FacilitatorSvmSigner } from "@x402/svm";
import { registerExactSvmScheme } from "@x402/svm/exact/facilitator";
import { SOLANA_DEVNET_CAIP2 } from "@blindfold/protocol";

export interface ExactOptions {
  /** Provider wallet that receives `exact` payments (USDC goes to its associated token account). */
  payTo: string;
  /** Facilitator that verifies and submits the payer's transfer; see `exactFacilitator`. */
  facilitator: FacilitatorClient;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** HTTP 429 from the RPC: the request was refused, not processed, so it is safe to repeat. */
function rateLimitDelay(e: unknown): number | null {
  const ctx = (e as { context?: { statusCode?: number; headers?: Headers } })?.context;
  if (ctx?.statusCode !== 429 && !/\b429\b/.test(String((e as Error)?.message))) return null;
  const after = Number(ctx?.headers?.get?.("retry-after"));
  return Number.isFinite(after) && after > 0 ? Math.min(after, 10) * 1000 : 0;
}

/** Wraps every RPC-backed signer method so rate-limited calls wait and retry (public devnet RPCs limit hard). */
export function retryRateLimited(signer: FacilitatorSvmSigner, tries = 8): FacilitatorSvmSigner {
  const wrapped: Record<string, unknown> = { ...signer };
  for (const [name, fn] of Object.entries(signer)) {
    if (typeof fn !== "function" || name === "getAddresses" || name === "getSigner") continue;
    wrapped[name] = async (...args: unknown[]) => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await (fn as (...a: unknown[]) => Promise<unknown>).apply(signer, args);
        } catch (e) {
          const delay = rateLimitDelay(e);
          if (delay === null || attempt >= tries) throw e;
          await sleep(Math.max(delay, 500 * 2 ** (attempt - 1)));
        }
      }
    };
  }
  return wrapped as FacilitatorSvmSigner;
}

/**
 * In-process `exact` facilitator. Its key pays transaction fees and co-signs; it never holds the payment.
 * `keypair` is a Solana CLI keypair (64-byte JSON array).
 */
export async function exactFacilitator(o: { keypair: Uint8Array; rpcUrl: string }): Promise<FacilitatorClient & { feePayer: string }> {
  const signer = await createKeyPairSignerFromBytes(o.keypair);
  const f = registerExactSvmScheme(new x402Facilitator(), {
    signer: retryRateLimited(toFacilitatorSvmSigner(signer, { defaultRpcUrl: o.rpcUrl })),
    networks: SOLANA_DEVNET_CAIP2,
  });
  return {
    feePayer: signer.address,
    getSupported: async () => f.getSupported() as Awaited<ReturnType<FacilitatorClient["getSupported"]>>,
    verify: (p, r) => f.verify(p, r),
    settle: (p, r) => f.settle(p, r),
  };
}

export const readKeypairFile = (path: string) => Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]);
