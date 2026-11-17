import { describe, expect, it } from "vitest";
import { loadAgentEnv, loadMintEnv, loadMockApiEnv, loadOwnerEnv, loadScriptsEnv, loadWalletEnv } from "../src/index.js";

const PK = "02" + "ab".repeat(32);
describe("env", () => {
  it("mint", () => {
    const e = loadMintEnv({ DATABASE_URL: "postgres://x", MINT_SEED: "00".repeat(32), MINT_AUTHORITY_KEYPAIR: "k.json", MINT_ADMIN_TOKEN: "t" });
    expect(e.PORT).toBe(3338);
    expect(e.USDC_MINT).toBeTruthy();
    expect(() => loadMintEnv({})).toThrow(/DATABASE_URL/);
    expect(() => loadMintEnv({ DATABASE_URL: "x", MINT_SEED: "zz", MINT_AUTHORITY_KEYPAIR: "k", MINT_ADMIN_TOKEN: "t" })).toThrow(/MINT_SEED/);
  });
  it("mock api defaults and port-derived public url", () => {
    const e = loadMockApiEnv({ PROVIDER_SECRET_KEY: "01".repeat(32) });
    expect(e).toMatchObject({ PORT: 4000, PRICE_CENTS: 5, PROVIDER_ID: 0, PUBLIC_URL: "http://localhost:4000" });
    expect(() => loadMockApiEnv({})).toThrow(/PROVIDER_SECRET_KEY/);
  });
  it("wallet and agent", () => {
    expect(loadWalletEnv({})).toMatchObject({ MAX_PER_CALL_CENTS: 10, APPROVAL_OVER_CENTS: 20, WALLET_ALLOWLIST: [] });
    expect(loadWalletEnv({ WALLET_ALLOWLIST: `${PK.toUpperCase()}, ${PK}` }).WALLET_ALLOWLIST).toEqual([PK, PK]);
    expect(() => loadWalletEnv({ WALLET_ALLOWLIST: "nope" })).toThrow();
    expect(loadAgentEnv({}).RESERVE_CHECK_EVERY).toBe(10);
    expect(loadAgentEnv({ RESERVE_CHECK_EVERY: "3" }).RESERVE_CHECK_EVERY).toBe(3);
    expect(() => loadAgentEnv({ RESERVE_CHECK_EVERY: "0" })).toThrow();
  });
  it("owner and scripts", () => {
    expect(loadOwnerEnv({ OWNER_KEYPAIR: "o.json" }).MINT_URL).toBe("http://localhost:3338");
    expect(() => loadOwnerEnv({})).toThrow(/OWNER_KEYPAIR/);
    expect(loadScriptsEnv({ ADMIN_KEYPAIR: "a.json" }).ADMIN_KEYPAIR).toBe("a.json");
    expect(() => loadScriptsEnv({ ADMIN_KEYPAIR: "a", SOLANA_RPC_URL: "nope" })).toThrow(/SOLANA_RPC_URL/);
  });
});
