// Baseline agent: pays with the standard x402 `exact` scheme from its own Solana wallet (it must hold a key and USDC).
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { SOLANA_DEVNET_CAIP2 } from "@blindfold/protocol";

/** `usdcMint` is the only asset it will pay, capped at `maxBasePerPayment` (default 100_000 = $0.10). */
export async function exactPayFetch(o: {
  keypair: Uint8Array; rpcUrl: string; usdcMint: string; maxBasePerPayment?: number; fetch?: typeof fetch;
}): Promise<{ address: string; fetch: typeof fetch }> {
  const signer = await createKeyPairSignerFromBytes(o.keypair);
  const client = new x402Client()
    .register(SOLANA_DEVNET_CAIP2, new ExactSvmScheme(signer, { rpcUrl: o.rpcUrl }))
    .setSpendControls({
      allowedAssets: [{ network: SOLANA_DEVNET_CAIP2, asset: o.usdcMint, maxAmountPerPayment: String(o.maxBasePerPayment ?? 100_000) }],
    });
  return { address: String(signer.address), fetch: wrapFetchWithPayment(o.fetch ?? fetch, client) };
}

/** The x402 settlement response header: for `exact`, `transaction` is the onchain transfer signature. */
export function paymentResponse(res: Response): { success?: boolean; transaction?: string; payer?: string } | null {
  const h = res.headers.get("PAYMENT-RESPONSE");
  if (!h) return null;
  try {
    return JSON.parse(Buffer.from(h, "base64").toString("utf8"));
  } catch {
    return null;
  }
}
