import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { Keypair, PublicKey } from "@solana/web3.js";
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
  return runInNewContext(source + ";({ summarize, explorerTx, load, loadCache })", {
    document, URL, URLSearchParams, TextEncoder, AbortSignal, atob,
    localStorage: { getItem: (key: string) => cache.get(key), setItem: (key: string, data: string) => cache.set(key, data) },
    setTimeout: (fn: () => void) => queueMicrotask(fn),
    location: { search: "?" + new URLSearchParams({ program, rpc: rpcUrl }) },
    solanaWeb3: { PublicKey },
    fetch: async (_: string, init: RequestInit) => {
      const { method } = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ result: response(method) }));
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
