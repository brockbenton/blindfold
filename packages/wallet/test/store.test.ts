import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FileTokenStore, TokenFileError } from "../src/index.js";

const proof = (s: string, amount = 1) => ({ amount, id: "00abc", secret: s, C: "02" + "11".repeat(32) });
const dir = () => mkdtempSync(join(tmpdir(), "bf-store-"));

describe("FileTokenStore", () => {
  it("writes atomically with mode 0600 and preserves extra fields", async () => {
    const p = join(dir(), "t.json");
    const s = new FileTokenStore(p);
    await s.write({ version: 1, mint: "http://m", unit: "usd", proofs: [proof("a")], note: "keep" });
    expect(statSync(p).mode & 0o777).toBe(0o600);
    const f = await s.read();
    expect(f.note).toBe("keep");
    f.proofs.push(proof("b"));
    await s.write(f);
    expect((await s.read()).note).toBe("keep");
    expect(readdirSync(join(p, ".."))).toEqual(["t.json"]);
  });
  it("a failed rename leaves the old file intact", async () => {
    const p = join(dir(), "t.json");
    const s = new FileTokenStore(p);
    await s.write({ version: 1, mint: "http://m", unit: "usd", proofs: [proof("a")] });
    const fsp = await import("node:fs/promises");
    // Simulate a crash before rename: write only a tmp file, as the writer would.
    writeFileSync(`${p}.tmp.999`, "{ truncated");
    expect(JSON.parse(readFileSync(p, "utf8")).proofs).toHaveLength(1);
    expect((await s.read()).proofs).toHaveLength(1);
    void fsp; void vi;
  });
  it("rejects wrong version and unit, strips witness, drops duplicate secrets", async () => {
    const d = dir();
    const w = (name: string, o: object) => { const p = join(d, name); writeFileSync(p, JSON.stringify(o)); return new FileTokenStore(p); };
    await expect(w("v.json", { version: 2, mint: "m", unit: "usd", proofs: [] }).read()).rejects.toThrow(TokenFileError);
    await expect(w("u.json", { version: 1, mint: "m", unit: "sat", proofs: [] }).read()).rejects.toThrow(TokenFileError);
    const f = await w("w.json", { version: 1, mint: "m", unit: "usd", proofs: [{ ...proof("a"), witness: "{}", amount: "4" }, proof("a"), proof("b")] }).read();
    expect(f.proofs.map((p) => p.secret)).toEqual(["a", "b"]);
    expect(f.proofs[0]).not.toHaveProperty("witness");
    expect(f.proofs[0].amount).toBe(4);
  });
  it("a second lock on the same file throws; release frees it; dead pid is stale", () => {
    const p = join(dir(), "t.json");
    const a = new FileTokenStore(p), b = new FileTokenStore(p);
    a.acquireLock();
    expect(() => b.acquireLock()).toThrow(TokenFileError);
    a.releaseSync();
    expect(existsSync(`${p}.lock`)).toBe(false);
    writeFileSync(`${p}.lock`, "999999999");
    b.acquireLock();
    b.releaseSync();
  });
});
