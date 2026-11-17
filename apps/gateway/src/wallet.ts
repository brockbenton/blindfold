// The gateway's shared Solana wallet: it pays every upstream `exact` purchase, for all agents.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import type { PayFetchFactory } from "./upstream.js";

/** Reads a Solana CLI keypair file (64-byte JSON array), creating one if `create` and it is missing. */
export function loadOrCreateKeypair(path: string, create: boolean): { bytes: Uint8Array; created: boolean } {
  if (existsSync(path)) return { bytes: Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]), created: false };
  if (!create) throw new Error(`${path} missing`);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const bytes = Uint8Array.from([...seed, ...pub]);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify([...bytes]), { mode: 0o600 });
  return { bytes, created: true };
}

/** `fetch` wrappers that pay x402 `exact` in `asset` from the wallet, each capped per payment. */
export async function walletPayFetch(o: { keypair: Uint8Array; rpcUrl: string; network: string; asset: string }): Promise<{ address: string; payFetch: PayFetchFactory }> {
  const signer = await createKeyPairSignerFromBytes(o.keypair);
  const payFetch: PayFetchFactory = (maxBase) => wrapFetchWithPayment(fetch, new x402Client()
    .register(o.network as `${string}:${string}`, new ExactSvmScheme(signer, { rpcUrl: o.rpcUrl }))
    .setSpendControls({ allowedAssets: [{ network: o.network as `${string}:${string}`, asset: o.asset, maxAmountPerPayment: String(maxBase) }] }));
  return { address: String(signer.address), payFetch };
}
