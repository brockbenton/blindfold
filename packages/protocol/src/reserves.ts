// Agent reserve check (00 section 7.6). Fails closed: never throws, any problem gives ok:false.
import { AccountLayout, AccountState, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { PublicKey } from "@solana/web3.js";
import { BASE_UNITS_PER_CENT, SOLANA_COMMITMENT } from "./constants.js";
import { baseUnitsToCents } from "./units.js";
import { configPda, decodeConfig, issuancePda, readIssuanceLog, vaultAta } from "./vault.js";
import type { ReservesResponse } from "./types.js";

/** Fetches the config, balance and issuance claim from the same bank. */
export interface ReserveConnection {
  getMultipleAccountsInfo(accounts: PublicKey[], commitment?: "confirmed"): Promise<({ owner: PublicKey; data: Uint8Array } | null)[]>;
}

export interface ReserveCheckResult {
  ok: boolean;
  vaultCents: number;
  /** The liabilities compared with the vault: the larger of the onchain log and the mint's report. */
  outstandingCents: number;
  /**
   * True when liabilities come from the vault's onchain issuance log, so they are a public claim the mint cannot
   * retract. False (or absent, in stubs) when only the mint's own report was available.
   */
  verified?: boolean;
  /** `issued - settled` from the onchain issuance log, when it exists. */
  onchainOutstandingCents?: number;
  /** `outstanding` from the mint's reserves endpoint, when it answered. */
  mintOutstandingCents?: number;
  /** Why the result is unverified, or which source was missing. */
  note?: string;
  reason?: string;
}

const cents = (base: bigint) => baseUnitsToCents(base - (base % BASE_UNITS_PER_CENT));

export async function checkReserves(opts: {
  connection: ReserveConnection;
  programId: PublicKey;
  usdcMint: PublicKey;
  mintUrl: string;
  fetch?: typeof fetch;
}): Promise<ReserveCheckResult> {
  let vaultCents = 0;
  let outstandingCents = 0;
  let verified = false;
  const extra: Pick<ReserveCheckResult, "onchainOutstandingCents" | "mintOutstandingCents" | "note"> = {};
  const fail = (reason: string): ReserveCheckResult => ({ ok: false, vaultCents, outstandingCents, verified, ...extra, reason });
  try {
    const { connection, programId, usdcMint } = opts;
    const vault = vaultAta(usdcMint, programId);

    const configAddress = configPda(programId);
    const [info, bal, logInfo] = await connection.getMultipleAccountsInfo([configAddress, vault, issuancePda(programId)], SOLANA_COMMITMENT);
    if (!info) return fail("config account not found");
    if (!info.owner.equals(programId)) return fail("config account is not owned by the vault program");
    const config = decodeConfig(info.data);
    if (!config.usdcMint.equals(usdcMint)) return fail("config usdc_mint does not match USDC_MINT");
    if (!config.vaultToken.equals(vault)) return fail("config vault_token is not the expected vault account");

    if (!bal?.owner.equals(TOKEN_PROGRAM_ID) || bal.data.length !== AccountLayout.span) return fail("invalid vault token account");
    const token = AccountLayout.decode(bal.data);
    if (!token.mint.equals(usdcMint) || !token.owner.equals(configAddress) || token.state !== AccountState.Initialized) {
      return fail("invalid vault token account");
    }
    vaultCents = cents(token.amount);

    // The mint's public issuance claim, if this vault has one. A wrong owner or garbage data fails closed.
    const log = readIssuanceLog(logInfo, programId);
    if (log) {
      if (log.settled > log.issued) return fail("issuance log is inconsistent: settled exceeds issued");
      extra.onchainOutstandingCents = cents(log.issued - log.settled);
    }

    const f = opts.fetch ?? fetch;
    let mintError: string | undefined;
    try {
      const res = await f(`${opts.mintUrl.replace(/\/+$/, "")}/v1/blindfold/reserves`, {
        redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) mintError = `reserves endpoint returned HTTP ${res.status}`;
      else {
        const body = (await res.json()) as Partial<ReservesResponse>;
        if (typeof body.outstanding !== "number" || !Number.isSafeInteger(body.outstanding) || body.outstanding < 0) {
          mintError = "reserves response has an invalid outstanding value";
        } else extra.mintOutstandingCents = body.outstanding;
      }
    } catch (e) {
      mintError = `reserves endpoint failed: ${(e as Error).message}`;
    }
    // The asynchronous log can omit recent issuance. Require the mint report too.
    if (mintError) return fail(mintError);

    const onchain = extra.onchainOutstandingCents;
    const reported = extra.mintOutstandingCents;
    // Use the larger claim: the mint may have issued tokens it has not logged yet.
    outstandingCents = Math.max(onchain ?? 0, reported ?? 0);
    verified = onchain !== undefined && onchain >= (reported ?? 0);
    if (onchain === undefined) extra.note = "unverified: no onchain issuance log, liabilities are mint-reported";
    else if (reported !== undefined && onchain !== undefined && reported > onchain) {
      extra.note = `mint reports ${reported - onchain} cents not yet logged onchain`;
    }

    if (vaultCents < outstandingCents) {
      return fail(`vault holds ${vaultCents} cents but ${outstandingCents} cents are outstanding`);
    }
    return { ok: true, vaultCents, outstandingCents, verified, ...extra };
  } catch (e) {
    return fail(`reserve check failed: ${(e as Error).message}`);
  }
}
