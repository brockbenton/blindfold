// End-to-end smoke against a running mint started with MINT_DEV_FAKE_CHAIN=1.
// Usage: MINT_URL=http://localhost:3338 MINT_ADMIN_TOKEN=... tsx scripts/smoke.ts
import { Amount, OutputData, createRandomSecretKey, getPubKeyFromPrivKey, signMintQuote, signP2PKProofs } from "@cashu/cashu-ts";
import { buildLockOptions, toWireProof } from "@blindfold/protocol";

const url = process.env.MINT_URL ?? "http://localhost:3338";
const token = process.env.MINT_ADMIN_TOKEN ?? "dev-admin";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const call = async (path: string, body?: unknown, auth = false) => {
  const r = await fetch(url + path, {
    method: body === undefined && !path.includes("settle") ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(j)}`);
  return j as any;
};
const show = (label: string, v: unknown) => console.log(label.padEnd(18), JSON.stringify(v));

const info = await call("/v1/info");
show("info nuts", Object.keys(info.nuts));
const keys = (await call("/v1/keys")).keysets[0];
show("keyset", { id: keys.id, keys: Object.keys(keys.keys).length });

const psk = createRandomSecretKey();
const ppk = hex(getPubKeyFromPrivKey(psk));
show("provider", await call("/dev/provider", { cashu_pubkey: ppk }, true));
show("providers", await call("/v1/blindfold/providers"));

const qsk = createRandomSecretKey();
const quote = await call("/v1/mint/quote/solana-usdc", { unit: "usd", amount: 100, pubkey: hex(getPubKeyFromPrivKey(qsk)) });
show("quote", { id: quote.quote, amount_base_units: quote.amount_base_units });
show("deposit", await call("/dev/deposit", { deposit_ref: quote.request, amount_cents: 100 }, true));
show("quote paid", (await call(`/v1/mint/quote/solana-usdc/${quote.quote}`)).amount_paid);

const ods = OutputData.createP2PKData(buildLockOptions([ppk]), 100, keys);
const outputs = ods.map((o) => ({ amount: Number(o.blindedMessage.amount.toString()), id: o.blindedMessage.id, B_: o.blindedMessage.B_ }));
const { signatures } = await call("/v1/mint/solana-usdc", {
  quote: quote.quote, outputs, signature: signMintQuote(hex(qsk), quote.quote, ods.map((o) => o.blindedMessage)),
});
const proofs = ods.map((od, i) => od.toProof({ ...signatures[i], amount: Amount.from(signatures[i].amount) } as never, keys));
show("minted", { proofs: proofs.length, cents: proofs.reduce((s, p) => s + p.amount.toNumber(), 0) });
show("reserves", await call("/v1/blindfold/reserves"));

const redeemed = await call("/v1/blindfold/redeem", { proofs: signP2PKProofs(proofs.slice(0, 2), hex(psk)).map(toWireProof) });
show("redeem", redeemed);
show("balances", await call("/v1/blindfold/admin/balances", undefined, true));
show("settle", await call("/v1/blindfold/admin/settle", undefined, true));
show("balances after", await call("/v1/blindfold/admin/balances", undefined, true));
show("reserves", await call("/v1/blindfold/reserves"));
show("reconcile", await call("/v1/blindfold/admin/reconcile", undefined, true));
