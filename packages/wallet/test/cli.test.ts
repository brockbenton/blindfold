import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { makeWorld, type World } from "./helpers.js";

let w: World;
afterEach(async () => { await w?.stop(); });

describe("owner CLI", () => {
  it("fund, balance and providers print the expected lines", async () => {
    w = await makeWorld();
    const lines: string[] = [];
    const deps = {
      out: (l: string) => lines.push(l), makeDepositor: () => w.depositor, env: { MINT_URL: w.mint.url },
      stateDir: join(w.dir, "state"), pollMs: 5,
    };
    await runCli(["fund", "--cents", "10", "--token-file", w.tokenFile], deps);
    expect(lines.find((l) => l.startsWith("balance"))).toBe("balance 10c in " + w.file().proofs.length + " new proofs");
    expect(lines).toContain("step mint");
    lines.length = 0;
    await runCli(["balance", "--token-file", w.tokenFile], deps);
    expect(lines[0]).toBe("spendable 10c");
    expect(lines[1]).toBe("pending 0c");
    lines.length = 0;
    await runCli(["providers"], deps);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(w.provider.pubkey);
  });

  it("errors propagate (bad cents)", async () => {
    w = await makeWorld();
    await expect(runCli(["fund", "--cents", "0", "--token-file", w.tokenFile], {
      out: () => undefined, makeDepositor: () => w.depositor, env: { MINT_URL: w.mint.url },
    })).rejects.toThrow(/cents/);
  });
});
