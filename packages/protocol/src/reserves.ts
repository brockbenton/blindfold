// Agent reserve check (00 section 7.6). Fails closed: never throws, any problem gives ok:false.
import type { PublicKey } from "@solana/web3.js";
import { BASE_UNITS_PER_CENT, SOLANA_COMMITMENT } from "./constants.js";
import { baseUnitsToCents } from "./units.js";
import { configPda, decodeConfig, vaultAta } from "./vault.js";
import type { ReservesResponse } from "./types.js";

/** The two Connection methods this check uses. */
export interface ReserveConnection {
  getTokenAccountBalance(account: PublicKey, commitment?: "confirmed"): Promise<{ value: { amount: string } }>;
  getAccountInfo(account: PublicKey, commitment?: "confirmed"): Promise<{ owner: PublicKey; data: Uint8Array } | null>;
}

export interface ReserveCheckResult {
  ok: boolean;
  vaultCents: number;
  outstandingCents: number;
  reason?: string;
}

export async function checkReserves(opts: {
  connection: ReserveConnection;
  programId: PublicKey;
  usdcMint: PublicKey;
  mintUrl: string;
  fetch?: typeof fetch;
}): Promise<ReserveCheckResult> {
  let vaultCents = 0;
  let outstandingCents = 0;
  const fail = (reason: string): ReserveCheckResult => ({ ok: false, vaultCents, outstandingCents, reason });
  try {
    const { connection, programId, usdcMint } = opts;
    const vault = vaultAta(usdcMint, programId);

    const info = await connection.getAccountInfo(configPda(programId), SOLANA_COMMITMENT);
    if (!info) return fail("config account not found");
    if (!info.owner.equals(programId)) return fail("config account is not owned by the vault program");
    const config = decodeConfig(info.data);
    if (!config.usdcMint.equals(usdcMint)) return fail("config usdc_mint does not match USDC_MINT");
    if (!config.vaultToken.equals(vault)) return fail("config vault_token is not the expected vault account");

    const bal = await connection.getTokenAccountBalance(vault, SOLANA_COMMITMENT);
    const balance = BigInt(bal.value.amount);
    if (balance < 0n) return fail("vault balance must not be negative");
    // Direct transfers can include dust; count only whole cents toward liabilities.
    vaultCents = baseUnitsToCents(balance - balance % BASE_UNITS_PER_CENT);

    const f = opts.fetch ?? fetch;
    const res = await f(`${opts.mintUrl.replace(/\/+$/, "")}/v1/blindfold/reserves`);
    if (!res.ok) return fail(`reserves endpoint returned HTTP ${res.status}`);
    const body = (await res.json()) as Partial<ReservesResponse>;
    if (typeof body.outstanding !== "number" || !Number.isSafeInteger(body.outstanding) || body.outstanding < 0) {
      return fail("reserves response has an invalid outstanding value");
    }
    outstandingCents = body.outstanding;
    if (vaultCents < outstandingCents) {
      return fail(`vault holds ${vaultCents} cents but ${outstandingCents} cents are outstanding`);
    }
    return { ok: true, vaultCents, outstandingCents };
  } catch (e) {
    return fail(`reserve check failed: ${(e as Error).message}`);
  }
}
