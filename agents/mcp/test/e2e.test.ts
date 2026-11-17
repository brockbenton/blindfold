// In-process end to end through the MCP protocol: an MCP client (with or without elicitation) talks to the real
// server over an in-memory transport; the server pays a real mock-api with a real wallet against a fake mint.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { BN, BorshAccountsCoder } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { VAULT_IDL, USDC_DEVNET_MINT, vaultAta } from "@blindfold/protocol";
import { makeProviderKey } from "@blindfold/testkit";
import { ownerFund } from "@blindfold/wallet";
import { FakeDepositor } from "../../../packages/wallet/test/fakes/fake-depositor.js";
import { FakeMint } from "../../../packages/wallet/test/fakes/fake-mint.js";
import { FakeProvider } from "../../../packages/wallet/test/fakes/fake-provider.js";
import { createApp } from "../../../apps/mock-api/src/app.js";
import { loadConfig } from "../src/config.js";
import { start } from "../src/start.js";

const providerKey = makeProviderKey();
const programId = Keypair.generate().publicKey;
const usdcMint = new PublicKey(USDC_DEVNET_MINT);
const dir = mkdtempSync(join(tmpdir(), "bf-mcp-"));
let fundedJson = "";

const configData = () => {
  const k = () => Keypair.generate().publicKey;
  return new BorshAccountsCoder(VAULT_IDL).encode("Config", {
    admin: k(), mint_authority: k(), usdc_mint: usdcMint, vault_token: vaultAta(usdcMint, programId),
    max_deposit: new BN(1), deposit_count: new BN(0), provider_count: 0, last_batch_id: new BN(0), bump: 1,
  });
};
const connection = (vaultCents: number) => ({
  async getAccountInfo() { return { owner: programId, data: await configData() }; },
  async getTokenAccountBalance() { return { value: { amount: String(vaultCents * 10_000) } }; },
});

const stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const s of stops.splice(0).reverse()) await s(); });

beforeAll(async () => {
  const mint = new FakeMint();
  const mintUrl = await mint.start();
  mint.setProviders([{ provider_id: 0, pubkey: providerKey.pubkey, name: "TokenFeed", url: null, price_cents: 5, topics: [], active: true }]);
  const tokenFile = join(dir, "funded.json");
  await ownerFund({ mintUrl, cents: 100, tokenFile, depositor: new FakeDepositor(mint), stateDir: join(dir, "state"), pollMs: 5 });
  fundedJson = readFileSync(tokenFile, "utf8");
  await mint.stop();
});

type Answer = "approve" | "deny" | "none";

async function world(o: { elicit?: Answer; vault?: number; env?: Record<string, string> } = {}) {
  const mint = new FakeMint();
  const mintUrl = await mint.start();
  stops.push(() => mint.stop());
  const app = createApp({ mintUrl, providerSecretKey: providerKey.sk, priceCents: 5 });
  const http = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((r) => setTimeout(r, 50));
  const apiUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  stops.push(() => new Promise<void>((r) => { (http as any).closeAllConnections?.(); http.close(() => r()); }));
  mint.setProviders([{ provider_id: 0, pubkey: providerKey.pubkey, name: "TokenFeed", url: apiUrl, price_cents: 5, topics: ["sol"], active: true }]);
  mint.reserves.outstanding = 50;

  const tokenFile = join(mkdtempSync(join(dir, "w-")), "tokens.json");
  writeFileSync(tokenFile, JSON.stringify({ ...JSON.parse(fundedJson), mint: mintUrl }));
  const cfg = loadConfig({ TOKEN_FILE: tokenFile, VAULT_PROGRAM_ID: programId.toBase58(), APPROVAL_TIMEOUT_S: "5", ...o.env });
  const s = await start(cfg, { connection: connection(o.vault ?? 100) as never });

  const elicited: string[] = [];
  const client = new Client({ name: "test", version: "1" }, { capabilities: o.elicit && o.elicit !== "none" ? { elicitation: { form: {} } } : {} });
  if (o.elicit && o.elicit !== "none") {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      elicited.push(req.params.message);
      return o.elicit === "approve" ? { action: "accept", content: { approve: true } } : { action: "decline" };
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([s.server.connect(a), client.connect(b)]);
  stops.push(async () => { await client.close(); await s.close(); });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { type: string; text: string }[])[0].text;
    return { isError: r.isError === true, body: JSON.parse(text) };
  };
  const balance = () => JSON.parse(readFileSync(tokenFile, "utf8")).proofs.reduce((t: number, p: { amount: number }) => t + p.amount, 0) as number;
  return { client, call, apiUrl, mint, mintUrl, elicited, balance };
}

describe("MCP server end to end", () => {
  it("exposes exactly the four tools, none of which can change a limit", async () => {
    const w = await world();
    const { tools } = await w.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["buy_data", "check_reserves", "get_balance", "list_providers"]);
    expect(tools.find((t) => t.name === "buy_data")!.description).toMatch(/untrusted/i);
  });

  it("lists providers, buys whale flow privately and reports the balance", async () => {
    const w = await world();
    const ps = await w.call("list_providers");
    expect(ps.body).toEqual([{ name: "TokenFeed", url: w.apiUrl, price_cents: 5, topics: ["sol"] }]);
    const r = await w.call("buy_data", { url: `${w.apiUrl}/v1/data/sol` });
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ ok: true, paid_cents: 5, balance_cents: 95, data: { topic: "sol" } });
    expect(r.body.note).toMatch(/untrusted/i);
    expect((await w.call("get_balance")).body).toMatchObject({ balance_cents: 95, spent_cents: 5 });
    expect(w.mint.redeemer.balances.get(0)).toBe(5);
    expect(w.balance()).toBe(95);
  });

  it("asks the owner through elicitation above the threshold, and pays when approved", async () => {
    const w = await world({ elicit: "approve" });
    const r = await w.call("buy_data", { url: `${w.apiUrl}/v1/data/sol/signals` });
    expect(r.body).toMatchObject({ ok: true, paid_cents: 25 });
    expect(w.elicited).toHaveLength(1);
    expect(w.elicited[0]).toMatch(/25 cents/);
  });

  it("an owner denial is a refusal; nothing is spent", async () => {
    const w = await world({ elicit: "deny" });
    const r = await w.call("buy_data", { url: `${w.apiUrl}/v1/data/sol/signals` });
    expect(r.body).toMatchObject({ refused: "approval_denied" });
    expect(w.elicited).toHaveLength(1);
    expect(w.balance()).toBe(100);
  });

  it("a client without elicitation gets purchases above the threshold refused, below it paid", async () => {
    const w = await world({ elicit: "none" });
    expect((await w.call("buy_data", { url: `${w.apiUrl}/v1/data/sol/signals` })).body).toMatchObject({ refused: "approval_denied" });
    expect((await w.call("buy_data", { url: `${w.apiUrl}/v1/data/sol` })).body).toMatchObject({ ok: true, paid_cents: 5 });
  });

  it("refuses a hostile provider: the tokens cannot pay an unregistered key", async () => {
    const w = await world();
    const evil = new FakeProvider({ sk: makeProviderKey().sk, mintUrl: w.mintUrl, spend: () => undefined, mode: "hostile", attackerKey: makeProviderKey().pubkey, keysetIds: [w.mint.keyset.id] });
    await evil.start();
    stops.push(() => evil.stop());
    const r = await w.call("buy_data", { url: `${evil.url}/v1/data/sol` });
    expect(r.body).toMatchObject({ refused: "provider_not_allowed" });
    expect(evil.paidRequests).toBe(0);
    expect(w.balance()).toBe(100);
  });

  it("session budget stops spending", async () => {
    const w = await world({ env: { BUDGET_CENTS: "10" } });
    for (let i = 0; i < 2; i++) expect((await w.call("buy_data", { url: `${w.apiUrl}/v1/data/sol` })).body.ok).toBe(true);
    expect((await w.call("buy_data", { url: `${w.apiUrl}/v1/data/sol` })).body).toMatchObject({ refused: "budget_exhausted" });
    expect(w.balance()).toBe(90);
  });

  it("reserve gate fails closed when the vault holds less than the mint owes", async () => {
    const w = await world({ vault: 10 });
    expect((await w.call("check_reserves")).body).toMatchObject({ ok: false, vault_cents: 10, outstanding_cents: 50 });
    expect((await w.call("buy_data", { url: `${w.apiUrl}/v1/data/sol` })).body).toMatchObject({ refused: "reserves_failed" });
    expect(w.mint.redeemCalls).toBe(0);
    expect(w.balance()).toBe(100);
  });
});
