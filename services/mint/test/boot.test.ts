import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupMint, newKey, newQuote, type Harness } from "./helpers.js";

let h: Harness;
beforeAll(async () => { h = await setupMint(); });
afterAll(async () => { await h.cleanup(); });

describe("boot and keys", () => {
  it("same MINT_SEED gives the same keyset, 13 keys 1..4096", async () => {
    const keys = (await h.req("/v1/keys")).json.keysets;
    expect(keys).toHaveLength(1);
    expect(Object.keys(keys[0].keys).map(Number)).toEqual(Array.from({ length: 13 }, (_, i) => 2 ** i));
    // second boot on the same database
    const h2 = await setupMint({ seedByte: 7 });
    expect((await h2.req("/v1/keys")).json.keysets[0].id).toBe(keys[0].id);
    await h2.cleanup();
    const h3 = await setupMint({ seedByte: 8 });
    expect((await h3.req("/v1/keys")).json.keysets[0].id).not.toBe(keys[0].id);
    await h3.cleanup();
  });
  it("refuses to boot when the seed derives a different keyset than the stored one", async () => {
    const { createMint } = await import("../src/mint.js");
    await expect(createMint({ db: h.db, cfg: { ...h.cfg, MINT_SEED: "09".repeat(32) }, vault: h.vault, sender: h.sender })).rejects.toThrow(/stored active keyset/);
  });
  it("serves keysets, keys by id and info", async () => {
    const id = (await h.keyset()).id;
    expect((await h.req("/v1/keysets")).json.keysets[0]).toMatchObject({ id, unit: "usd", active: true, input_fee_ppk: 0 });
    expect((await h.req(`/v1/keys/${id}`)).json.keysets[0].id).toBe(id);
    expect((await h.req("/v1/keys/00nope")).json.code).toBe(12001);
    const info = (await h.req("/v1/info")).json;
    expect(info.nuts[4].methods[0]).toMatchObject({ method: "solana-usdc", unit: "usd", min_amount: 1, max_amount: 5000 });
    expect(info.nuts[5].disabled).toBe(true);
    for (const n of [7, 10, 11, 12, 20]) expect(info.nuts[n]).toEqual({ supported: true });
  });
});

describe("quotes", () => {
  it("returns 404 / 20001 for an unknown quote", async () => {
    const r = await h.req("/v1/mint/quote/solana-usdc/018f0000-0000-7000-8000-000000000000");
    expect(r).toMatchObject({ status: 404, json: { code: 20001 } });
    expect((await h.req("/v1/mint/quote/solana-usdc/not-a-uuid")).status).toBe(404);
  });
  it("validates unit, amount and pubkey", async () => {
    const pubkey = newKey().pubkey;
    const post = (body: object) => h.req("/v1/mint/quote/solana-usdc", { body });
    expect(await post({ unit: "sat", amount: 5, pubkey })).toMatchObject({ status: 400, json: { code: 11013 } });
    expect((await post({ unit: "usd", amount: 0, pubkey })).json.code).toBe(11006);
    expect((await post({ unit: "usd", amount: 5001, pubkey })).json.code).toBe(11006);
    expect((await post({ unit: "usd", amount: 1.5, pubkey })).json.code).toBe(11006);
    expect((await post({ unit: "usd", amount: 5 })).json.code).toBe(20009);
    expect((await post({ unit: "usd", amount: 5, pubkey: "04" + "11".repeat(32) })).json.code).toBe(20009);
    expect((await h.req("/v1/mint/quote/solana-usdc", { raw: "{nope" })).json.code).toBe(10000);
  });
  it("creates quotes with unique deposit_ref and the contract shape", async () => {
    const a = await newQuote(h, 500), b = await newQuote(h, 5000);
    expect(a.request).toMatch(/^[0-9a-f]{64}$/);
    expect(a.request).not.toBe(b.request);
    const got = (await h.req(`/v1/mint/quote/solana-usdc/${a.quote}`)).json;
    expect(got).toMatchObject({
      quote: a.quote, request: a.request, unit: "usd", method: "solana-usdc", amount: 500, pubkey: a.pubkey,
      amount_paid: 0, amount_issued: 0, vault_program: h.cfg.VAULT_PROGRAM_ID, usdc_mint: h.cfg.USDC_MINT, amount_base_units: "5000000",
    });
    expect(got.expiry - got.updated_at).toBeGreaterThan(3590);
    expect(a.quote[14]).toBe("7"); // uuid v7
  });
});
