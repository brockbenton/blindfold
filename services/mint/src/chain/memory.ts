// In-memory vault and settlement sender. Used by tests and by the dev-only fake-chain mode (MINT_DEV_FAKE_CHAIN=1).
import type { DepositRecordAccount, ProviderRecordAccount } from "@blindfold/protocol";
import { Keypair, PublicKey } from "@solana/web3.js";
import { ProgramError, type ConfirmStatus, type SettleSender, type SettlePayout } from "./settleSender.js";
import type { VaultConfigView, VaultReader } from "./vaultReader.js";

const bytes = (v: string | Uint8Array) => (typeof v === "string" ? Uint8Array.from(Buffer.from(v, "hex")) : v);

export class MemoryVault implements VaultReader {
  deposits: DepositRecordAccount[] = [];
  providers: ProviderRecordAccount[] = [];
  lastBatchId = 0n;
  balanceBase = 0n;
  /** Base units paid out per provider id by the fake sender. */
  paid = new Map<number, bigint>();
  /** Make getDeposits throw (simulates a wrong account owner). */
  failReads = false;

  addDeposit(o: { amountBase: bigint; depositRef: string | Uint8Array; depositor?: PublicKey }): DepositRecordAccount {
    const rec: DepositRecordAccount = {
      index: BigInt(this.deposits.length),
      depositor: o.depositor ?? Keypair.generate().publicKey,
      amount: o.amountBase,
      depositRef: bytes(o.depositRef),
      slot: 1n,
      timestamp: BigInt(Math.floor(Date.now() / 1000)),
      bump: 255,
    };
    this.deposits.push(rec);
    this.balanceBase += o.amountBase;
    return rec;
  }

  addProvider(o: { cashuPubkey: string | Uint8Array; payoutToken?: PublicKey | string }): ProviderRecordAccount {
    const rec: ProviderRecordAccount = {
      providerId: this.providers.length,
      cashuPubkey: bytes(o.cashuPubkey),
      payoutToken: o.payoutToken ? new PublicKey(o.payoutToken) : Keypair.generate().publicKey,
      active: true,
      bump: 255,
    };
    this.providers.push(rec);
    return rec;
  }

  setActive(id: number, active: boolean) {
    this.providers[id].active = active;
  }

  async getConfig(): Promise<VaultConfigView> {
    return { depositCount: BigInt(this.deposits.length), providerCount: this.providers.length, lastBatchId: this.lastBatchId };
  }
  async getDeposits(indices: bigint[]): Promise<(DepositRecordAccount | null)[]> {
    if (this.failReads) throw new Error("DepositRecord is not owned by the vault program");
    return indices.map((i) => this.deposits[Number(i)] ?? null);
  }
  async getProvider(id: number) {
    return this.providers[id] ?? null;
  }
  async getVaultBalanceBase() {
    return this.balanceBase;
  }
}

type Knob = { kind: "send" } | { kind: "afterLand" } | { kind: "program"; name: string } | { kind: "race" } | { kind: "neverLand" };

/** Mimics the program's settle_batch checks. One-shot failure knobs. */
export class FakeSender implements SettleSender {
  sends = 0;
  landed = new Set<string>();
  height = 0;
  private knobs: Knob[] = [];
  private n = 0;
  constructor(private vault: MemoryVault) {}

  failNext(kind: "send" | "afterLand"): this {
    this.knobs.push({ kind });
    return this;
  }
  /** Deterministic program error, e.g. ProviderInactive. */
  failNextProgram(name: string): this {
    this.knobs.push({ kind: "program", name });
    return this;
  }
  /** The batch lands through another path just before this send: the program answers BadBatchId. */
  raceNext(): this {
    this.knobs.push({ kind: "race" });
    return this;
  }
  neverLand(): this {
    this.knobs.push({ kind: "neverLand" });
    return this;
  }
  advance(blocks: number) {
    this.height += blocks;
  }

  async submit(batchId: bigint, payouts: SettlePayout[]) {
    const knob = this.knobs.shift();
    if (knob?.kind === "send") throw new Error("rpc unavailable");
    if (knob?.kind === "program") throw new ProgramError(knob.name);
    if (knob?.kind === "race") this.vault.lastBatchId += 1n;
    if (batchId !== this.vault.lastBatchId + 1n) throw new ProgramError("BadBatchId");
    if (payouts.length < 1 || payouts.length > 8) throw new ProgramError("TooManyPayouts");
    for (const p of payouts) {
      const rec = this.vault.providers[p.providerId];
      if (!rec) throw new ProgramError("ProviderMismatch");
      if (!rec.active) throw new ProgramError("ProviderInactive");
      if (rec.payoutToken.toBase58() !== p.payoutToken) throw new ProgramError("PayoutAccountMismatch");
      if (p.amountBase <= 0n || p.amountBase % 10_000n !== 0n) throw new ProgramError("AmountNotWholeCents");
    }
    this.sends++;
    const tx = `fake-tx-${++this.n}`;
    const validUntil = this.height + 100;
    if (knob?.kind === "neverLand") return { tx, validUntil };
    this.vault.lastBatchId = batchId;
    for (const p of payouts) {
      this.vault.balanceBase -= p.amountBase;
      this.vault.paid.set(p.providerId, (this.vault.paid.get(p.providerId) ?? 0n) + p.amountBase);
    }
    this.landed.add(tx);
    if (knob?.kind === "afterLand") throw new Error("connection lost after send");
    return { tx, validUntil };
  }

  async confirm(tx: string): Promise<ConfirmStatus> {
    return this.landed.has(tx) ? "confirmed" : "pending";
  }
  async isExpired(validUntil: number) {
    return this.height > validUntil;
  }
}
