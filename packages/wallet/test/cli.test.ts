import { join } from "node:path";
import { readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { DevDepositor } from "../src/depositor.js";
import { ownerBalance } from "../src/owner.js";
import { makeWorld, type World } from "./helpers.js";

let w: World;
afterEach(async () => { vi.restoreAllMocks(); await w?.stop(); });

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

  it("resumes fake-chain funding from an explicit state directory without an owner key", async () => {
    w = await makeWorld();
    const stateDir = join(w.dir, "recovery");
    const deps = {
      out: () => undefined, env: { MINT_URL: w.mint.url, MINT_ADMIN_TOKEN: "dev-admin" },
      stateDir: join(w.dir, "unused"), pollMs: 5,
      makeDepositor: () => ({ deposit: async () => { throw new Error("interrupted before deposit"); } }),
    };
    await expect(runCli(["fund", "--cents", "10", "--token-file", w.tokenFile, "--state-dir", stateDir], deps))
      .rejects.toThrow("interrupted before deposit");
    const [saved] = readdirSync(stateDir);
    const deposit = vi.spyOn(DevDepositor.prototype, "deposit").mockImplementation((a) => w.depositor.deposit(a));
    await runCli(["resume", saved.replace(".json", ""), "--state-dir", stateDir, "--dev-deposit"], deps);
    expect(deposit).toHaveBeenCalledOnce();
    expect(w.depositor.calls).toHaveLength(1);
    expect((await ownerBalance(w.tokenFile)).spendable).toBe(10);
    expect(readdirSync(stateDir)).toHaveLength(0);
  });
});
