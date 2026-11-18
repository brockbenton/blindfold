import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { Keypair, PublicKey } from "@solana/web3.js";
import { USDC_DEVNET_MINT, checkReserves, configPda, issuancePda, vaultAta } from "@blindfold/protocol";
import { describe, expect, it } from "vitest";
import { explorerTx } from "../lib/explorer.js";

const page = readFileSync(new URL("../vault-history/vault-history.js", import.meta.url), "utf8");
const program = Keypair.generate().publicKey.toBase58();
const rpcUrl = "https://rpc.example.test/rpc-key-placeholder";

function history(response: (method: string) => unknown = () => null) {
  const nodes = new Map();
  const document = {
    getElementById(id: string) {
      if (!nodes.has(id)) nodes.set(id, { querySelector: () => ({ addEventListener() {} }) });
      return nodes.get(id);
    },
  };
  const cache = new Map<string, string>();
  const source = page.slice(0, page.indexOf('$("program").textContent'));
  return runInNewContext(source + ";({ summarize, explorerTx, load, loadCache, reserveVerdict, verdictSnapshot })", {
    document, URL, URLSearchParams, TextEncoder, AbortSignal, atob,
    localStorage: { getItem: (key: string) => cache.get(key), setItem: (key: string, data: string) => cache.set(key, data) },
    setTimeout: (fn: () => void) => queueMicrotask(fn),
    location: { search: "?" + new URLSearchParams({ program, rpc: rpcUrl }) },
    solanaWeb3: { PublicKey },
    fetch: async (_: string, init: RequestInit) => {
      const { method } = JSON.parse(String(init.body));
      const result = response(method);
      if (result instanceof Error) return new Response(JSON.stringify({ error: { code: -32000, message: result.message } }));
      return new Response(JSON.stringify({ result }));
    },
  });
}

describe("vault history", () => {
  it("omits private RPC endpoints from the public explorer links", () => {
    expect(history().explorerTx("sample")).toBe("https://explorer.solana.com/tx/sample?cluster=devnet");
    expect(explorerTx("sample", rpcUrl)).toBe("https://explorer.solana.com/tx/sample?cluster=devnet");
  });

  it("attributes each event to the program that emitted it", () => {
    const other = Keypair.generate().publicKey.toBase58();
    const event = Buffer.alloc(32);
    Buffer.from("280a45c80cd1b3fd", "hex").copy(event);
    event.writeBigUInt64LE(500_000n, 8);
    const log = "Program data: " + event.toString("base64");
    const tx = {
      transaction: { message: { accountKeys: [] } },
      meta: { logMessages: [
        `Program ${program} invoke [1]`, "Program log: Instruction: LogIssuance",
        `Program ${other} invoke [2]`, log, `Program ${other} success`,
        log, `Program ${program} success`,
      ] },
    };
    expect(history().summarize("test", tx, "vault").events).toEqual([
      { name: "IssuanceLogged", issued: "500000", settled: "0", seq: "0" },
    ]);
  });

  it("keeps the checkpoint behind RPC transactions that are unavailable or partial", async () => {
    let available = false;
    const h = history((method) => {
      if (method === "getSignaturesForAddress") return [{ signature: "sample", err: null }];
      if (method === "getTransaction") return available
        ? { slot: 1, blockTime: null, transaction: { message: { accountKeys: [] } }, meta: {} } : null;
      if (method === "getTokenAccountBalance") return { value: { amount: "0" } };
      return null;
    });
    await h.load();
    expect(h.loadCache().newest).toEqual({});
    available = true;
    await h.load();
    expect(h.loadCache().newest[program]).toBe("sample");
    expect(h.loadCache().txs.sample).toMatchObject({ slot: 1 });
  });
});

describe("reserve coverage verdict", () => {
  const programKey = new PublicKey(program);
  const usdc = new PublicKey(USDC_DEVNET_MINT);
  const config = configPda(programKey);
  const vault = vaultAta(usdc, programKey);
  const addresses = { config: config.toBase58(), vault: vault.toBase58(), issuance: issuancePda(programKey).toBase58() };
  const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const account = (owner: string, data: Buffer) => ({ owner, data: [data.toString("base64"), "base64"], lamports: 1, executable: false });
  const configAccount = () => {
    const d = Buffer.alloc(165);
    Buffer.from("9b0caae01efacc82", "hex").copy(d);
    usdc.toBuffer().copy(d, 72);
    vault.toBuffer().copy(d, 104);
    return account(program, d);
  };
  const vaultAccount = (amount: bigint) => {
    const d = Buffer.alloc(165);
    usdc.toBuffer().copy(d, 0);
    config.toBuffer().copy(d, 32);
    d.writeBigUInt64LE(amount, 64);
    d[108] = 1;
    return account(TOKEN, d);
  };
  const logAccount = (issued: bigint, settled: bigint) => {
    const d = Buffer.alloc(49);
    Buffer.from("13609a201322caf1", "hex").copy(d);
    d.writeBigUInt64LE(issued, 8);
    d.writeBigUInt64LE(settled, 16);
    return account(program, d);
  };
  const snapshot = (vaultAmount: bigint, log: unknown) => ({ context: { slot: 4242 }, value: [configAccount(), vaultAccount(vaultAmount), log] });
  const complete = { complete: true };

  it("is covered when the vault holds the published outstanding claims", () => {
    const v = history().reserveVerdict({ result: snapshot(3_500_000n, logAccount(4_100_000n, 1_000_000n)), history: complete, addresses });
    expect(v).toMatchObject({
      status: "covered", slot: 4242, vault: "3500000", issued: "4100000", settled: "1000000", outstanding: "3100000", margin: "400000",
      program, accounts: { config: addresses.config, vault: addresses.vault, issuanceLog: addresses.issuance },
    });
    expect(JSON.parse(JSON.stringify(v))).toEqual(v);
  });

  it("compares whole cents the way the agent reserve check does", () => {
    // 3.099999 USDC vault against 3.10 outstanding floors to 309 < 310 cents.
    const short = history().reserveVerdict({ result: snapshot(3_099_999n, logAccount(4_100_000n, 1_000_000n)), history: complete, addresses });
    expect(short).toMatchObject({ status: "not covered", compared: { vaultCents: "309", outstandingCents: "310" } });
    // Sub-cent dust on the claim side floors away.
    const dust = history().reserveVerdict({ result: snapshot(3_100_000n, logAccount(4_100_009n, 1_000_000n)), history: complete, addresses });
    expect(dust.status).toBe("covered");
  });

  it("agrees with the protocol's checkReserves on the onchain side", async () => {
    const h = history();
    const cases: [bigint, bigint, bigint][] = [[3_500_000n, 4_100_000n, 1_000_000n], [3_099_999n, 4_100_000n, 1_000_000n], [0n, 0n, 0n], [10_000n, 19_999n, 0n]];
    for (const [amount, issued, settled] of cases) {
      const result = snapshot(amount, logAccount(issued, settled));
      const connection = {
        getMultipleAccountsInfo: async () => result.value.map((a) => ({ owner: new PublicKey(a.owner), data: Buffer.from(a.data[0], "base64") })),
      };
      // A mint reporting nothing outstanding leaves only the onchain claim in the comparison.
      const stubFetch = (async () => new Response(JSON.stringify({ outstanding: 0 }))) as unknown as typeof fetch;
      const r = await checkReserves({ connection, programId: programKey, usdcMint: usdc, mintUrl: "http://mint.test", fetch: stubFetch });
      const v = h.reserveVerdict({ result, history: complete, addresses });
      expect({ status: v.status, vault: Number(v.compared.vaultCents), outstanding: Number(v.compared.outstandingCents) })
        .toEqual({ status: r.ok ? "covered" : "not covered", vault: r.vaultCents, outstanding: r.onchainOutstandingCents });
    }
  });

  it("reports a deficit as not covered", () => {
    const v = history().reserveVerdict({ result: snapshot(500_000n, logAccount(4_100_000n, 1_000_000n)), history: complete, addresses });
    expect(v).toMatchObject({ status: "not covered", outstanding: "3100000", margin: "-2600000" });
  });

  it("is unknown, never covered, when the issuance log is not initialized", () => {
    const h = history();
    for (const log of [null, account("11111111111111111111111111111111", Buffer.alloc(0))]) {
      const v = h.reserveVerdict({ result: snapshot(10_000_000n, log), history: complete, addresses });
      expect(v).toMatchObject({ status: "unknown", vault: "10000000", outstanding: null, margin: null });
      expect(v.reason).toMatch(/not initialized/);
    }
  });

  it("is unknown for a foreign, malformed or inconsistent issuance log", () => {
    const h = history();
    const foreign = account(Keypair.generate().publicKey.toBase58(), Buffer.from(logAccount(0n, 0n).data[0], "base64"));
    const garbage = account(program, Buffer.alloc(49));
    for (const log of [foreign, garbage, logAccount(1_000_000n, 2_000_000n)]) {
      expect(h.reserveVerdict({ result: snapshot(10_000_000n, log), history: complete, addresses }).status).toBe("unknown");
    }
  });

  it("is unknown when the vault or config account does not check out", () => {
    const h = history();
    const log = logAccount(1_000_000n, 0n);
    const wrongVault = { context: { slot: 1 }, value: [configAccount(), account(TOKEN, Buffer.alloc(165)), log] };
    const noConfig = { context: { slot: 1 }, value: [null, vaultAccount(10_000_000n), log] };
    for (const result of [wrongVault, noConfig]) expect(h.reserveVerdict({ result, history: complete, addresses }).status).toBe("unknown");
  });

  it("is unknown when the RPC read fails; transaction history does not gate the verdict", () => {
    const h = history();
    expect(h.reserveVerdict({ error: "RPC HTTP 503", history: complete, addresses })).toMatchObject({ status: "unknown", slot: null, vault: null });
    expect(h.reserveVerdict({ result: null, history: complete, addresses }).status).toBe("unknown");
    const result = snapshot(10_000_000n, logAccount(1_000_000n, 0n));
    expect(h.reserveVerdict({ result, history: { complete: false }, addresses })).toMatchObject({ status: "covered", historyComplete: false });
    expect(h.reserveVerdict({ result, history: { complete: false, error: "rate limited" }, addresses }).reason).toContain("history unavailable");
    expect(h.reserveVerdict({ result, addresses }).reason).toContain("still loading");
  });

  it("renders unknown on the page when getMultipleAccounts fails", async () => {
    const h = history((method) => {
      if (method === "getMultipleAccounts") return new Error("account read refused");
      if (method === "getSignaturesForAddress") return [];
      if (method === "getTokenAccountBalance") return { value: { amount: "0" } };
      return null;
    });
    await h.load();
    expect(h.verdictSnapshot()).toMatchObject({ status: "unknown" });
    expect(h.verdictSnapshot().reason).toMatch(/RPC read failed/);
  });

  it("renders covered on the page from one shared-context snapshot", async () => {
    const h = history((method) => {
      if (method === "getMultipleAccounts") return snapshot(2_000_000n, logAccount(1_500_000n, 0n));
      if (method === "getSignaturesForAddress") return [];
      if (method === "getTokenAccountBalance") return { value: { amount: "2000000" } };
      return null;
    });
    await h.load();
    expect(h.verdictSnapshot()).toMatchObject({ status: "covered", slot: 4242, margin: "500000" });
  });
});
