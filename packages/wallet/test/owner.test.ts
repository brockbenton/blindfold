import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ownerBalance, ownerFund, ownerResume } from "../src/index.js";
import { signerSet } from "@blindfold/protocol";
import { FakeDepositor } from "./fakes/fake-depositor.js";
import { makeWorld, type World } from "./helpers.js";

let w: World;
afterEach(async () => { await w?.stop(); });
const fundArgs = (cents: number, extra: object = {}) => ({
  mintUrl: w.mint.url, cents, tokenFile: w.tokenFile, depositor: w.depositor, stateDir: join(w.dir, "state"), pollMs: 5, ...extra,
});
const total = (f: any) => f.proofs.reduce((s: number, p: any) => s + p.amount, 0);

describe("ownerFund", () => {
  it("locks to ALL active providers only and records deposit_ref via the depositor", async () => {
    w = await makeWorld();
    w.mint.setProviders(w.mint.providers.map((p) => (p.provider_id === 1 ? { ...p, active: false } : p)));
    const r = await ownerFund(fundArgs(10));
    expect(r.cents).toBe(10);
    const f = w.file();
    expect(total(f)).toBe(10);
    for (const p of f.proofs) expect(signerSet(p.secret)).toEqual([w.provider.pubkey]);
    expect(w.depositor.calls).toHaveLength(1);
    expect(w.depositor.calls[0].depositRef).toMatch(/^[0-9a-f]{64}$/);
    expect((await ownerBalance(w.tokenFile)).spendable).toBe(10);
  });

  it("resends the identical request after a lost mint response and gets the stored signatures", async () => {
    w = await makeWorld();
    w.mint.dropNextMintResponse = true;
    await ownerFund(fundArgs(10));
    expect(w.mint.mintRequests).toBe(2);
    expect(total(w.file())).toBe(10);
  });

  it("a bad DLEQ aborts without writing the token file", async () => {
    w = await makeWorld();
    w.mint.corruptDleq = true;
    await expect(ownerFund(fundArgs(10))).rejects.toThrow(/DLEQ/);
    expect(existsSync(w.tokenFile)).toBe(false);
  });

  it("refuses an empty or fully inactive provider list", async () => {
    w = await makeWorld();
    w.mint.setProviders([]);
    await expect(ownerFund(fundArgs(10))).rejects.toThrow(/no active providers/);
    w.mint.setProviders([{ provider_id: 0, pubkey: w.provider.pubkey, name: null, url: null, price_cents: null, topics: [], active: false }]);
    await expect(ownerFund(fundArgs(10))).rejects.toThrow(/no active providers/);
    expect(w.depositor.calls).toHaveLength(0);
  });

  it("rejects out-of-range amounts before any request", async () => {
    w = await makeWorld();
    await expect(ownerFund(fundArgs(0))).rejects.toThrow(RangeError);
    await expect(ownerFund(fundArgs(5001))).rejects.toThrow(RangeError);
  });

  it("resumes from a state saved after the deposit without depositing twice", async () => {
    w = await makeWorld();
    await expect(ownerFund(fundArgs(10, { onProgress: (s: string) => { if (s === "wait_paid") throw new Error("crash"); } }))).rejects.toThrow("crash");
    expect(w.depositor.calls).toHaveLength(1);
    expect(existsSync(w.tokenFile)).toBe(false);
    const [file] = readdirSync(join(w.dir, "state"));
    const pk = file.replace(".json", "");
    const dep = new FakeDepositor(w.mint);
    const r = await ownerResume(pk, { depositor: dep, stateDir: join(w.dir, "state"), pollMs: 5 });
    expect(dep.calls).toHaveLength(0);
    expect(r.depositTx).toBe("fake-sig-1");
    expect(total(w.file())).toBe(10);
    expect(readdirSync(join(w.dir, "state"))).toHaveLength(0);
  });

  it("resumes after the mint already issued (crash before the file write)", async () => {
    w = await makeWorld();
    await expect(ownerFund(fundArgs(10, { onProgress: (s: string) => { if (s === "write") throw new Error("crash"); } }))).rejects.toThrow("crash");
    expect(w.mint.mintRequests).toBe(1);
    const pk = readdirSync(join(w.dir, "state"))[0].replace(".json", "");
    await ownerResume(pk, { depositor: w.depositor, stateDir: join(w.dir, "state"), pollMs: 5 });
    expect(w.mint.mintRequests).toBe(2); // identical resend, stored signatures
    expect(w.depositor.calls).toHaveLength(1);
    expect(total(w.file())).toBe(10);
  });

  it("tops up an existing token file", async () => {
    w = await makeWorld();
    await ownerFund(fundArgs(10));
    await ownerFund(fundArgs(10));
    expect(total(w.file())).toBe(20);
  });

  it("a top-up never writes underneath an agent that holds the token file lock", async () => {
    w = await makeWorld();
    await ownerFund(fundArgs(10));
    const wallet = await w.open();
    await expect(ownerFund(fundArgs(10))).rejects.toThrow(/owner resume/);
    expect(total(w.file())).toBe(10);
    wallet.close();
    const pk = readdirSync(join(w.dir, "state"))[0].replace(".json", "");
    await ownerResume(pk, { depositor: w.depositor, stateDir: join(w.dir, "state"), pollMs: 5 });
    expect(w.depositor.calls).toHaveLength(2);
    expect(total(w.file())).toBe(20);
    expect(existsSync(`${w.tokenFile}.lock`)).toBe(false);
    // The agent can open the file again: the owner released its lock.
    expect((await w.open()).balance()).toBe(20);
  });

  it("state file is mode 0600", async () => {
    w = await makeWorld();
    await expect(ownerFund(fundArgs(10, { onProgress: (s: string) => { if (s === "deposit") throw new Error("stop"); } }))).rejects.toThrow("stop");
    const f = join(w.dir, "state", readdirSync(join(w.dir, "state"))[0]);
    expect((await import("node:fs")).statSync(f).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(f, "utf8")).quoteKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("chunks plans over 256 outputs into several mint requests", async () => {
    w = await makeWorld();
    await ownerFund(fundArgs(400, { prices: { 0: 1 } }));
    expect(w.mint.mintRequests).toBe(2);
    expect(total(w.file())).toBe(400);
    expect(w.file().proofs.length).toBeGreaterThan(256);
  }, 120_000);
});
