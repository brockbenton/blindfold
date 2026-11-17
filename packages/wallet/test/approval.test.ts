// Owner approval: payments above the threshold wait for an approver, enforced by the wallet before any proof leaves.
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  PaymentRefused, anyApprover, approvalBroker, askApproval, fixedApprover, terminalApprover,
  type ApprovalRequest, type Approver,
} from "../src/index.js";
import { makeWorld, type World } from "./helpers.js";

let w: World;
afterEach(async () => { await w?.stop(); });

/** A 25-cent feed and a wallet that may pay up to 50 cents, asking above 20. */
async function world(approve?: Approver, approvalTimeoutMs = 2000) {
  w = await makeWorld({ priceCents: 25 });
  await w.fund(100, { 0: 25 });
  const asked: ApprovalRequest[] = [];
  const wallet = await w.open({
    maxPerCallCents: 50, approvalOverCents: 20, approvalTimeoutMs,
    approve: approve && (async (r, s) => { asked.push(r); return approve(r, s); }),
  });
  return { wallet, asked, url: `${w.provider.url}/v1/data/sol` };
}

async function refusal(p: Promise<unknown>) {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(PaymentRefused);
  return e as PaymentRefused;
}

describe("wallet approval threshold", () => {
  it("pays without asking at or below the threshold", async () => {
    w = await makeWorld({ priceCents: 20 });
    await w.fund(100, { 0: 20 });
    let asked = 0;
    const wallet = await w.open({ maxPerCallCents: 50, approvalOverCents: 20, approve: async () => { asked++; return false; } });
    expect((await wallet.payFetch(`${w.provider.url}/v1/data/sol`)).status).toBe(200);
    expect(asked).toBe(0);
    expect(wallet.balance()).toBe(80);
  });

  it("asks with the exact challenge price and pays when approved", async () => {
    const { wallet, asked, url } = await world(fixedApprover(true));
    expect((await wallet.payFetch(url)).status).toBe(200);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ cents: 25, url, provider: w.provider.pubkey, thresholdCents: 20 });
    expect(wallet.balance()).toBe(75);
  });

  it("refuses with approval_denied when denied: nothing paid, file unchanged", async () => {
    const { wallet, asked, url } = await world(fixedApprover(false));
    const before = readFileSync(w.tokenFile, "utf8");
    expect((await refusal(wallet.payFetch(url))).reason).toBe("approval_denied");
    expect(asked).toHaveLength(1);
    expect(readFileSync(w.tokenFile, "utf8")).toBe(before);
    expect(w.provider.paidRequests).toBe(0);
  });

  it("refuses with approval_timeout when nobody answers in time", async () => {
    let aborted = false;
    const { wallet, url } = await world((_r, s) => new Promise((resolve) => { s.addEventListener("abort", () => { aborted = true; }); void resolve; }), 50);
    expect((await refusal(wallet.payFetch(url))).reason).toBe("approval_timeout");
    expect(aborted).toBe(true);
    expect(wallet.balance()).toBe(100);
  });

  it("refuses above the threshold when no approver is configured", async () => {
    const { wallet, url } = await world(undefined);
    expect((await refusal(wallet.payFetch(url))).reason).toBe("approval_denied");
  });

  it("checks the cap before asking: the owner is never asked about a payment the wallet would refuse", async () => {
    w = await makeWorld({ priceCents: 25 });
    await w.fund(100, { 0: 25 });
    let asked = 0;
    const wallet = await w.open({ maxPerCallCents: 10, approvalOverCents: 5, approve: async () => { asked++; return true; } });
    expect((await refusal(wallet.payFetch(`${w.provider.url}/v1/data/sol`))).reason).toBe("over_cap");
    expect(asked).toBe(0);
  });
});

const req: ApprovalRequest = { id: "a1", cents: 25, url: "http://feed/v1/data/sol/signals", provider: "02ab", thresholdCents: 20, timeoutMs: 1000 };

describe("approvers", () => {
  it("askApproval treats errors and non-true answers as denials", async () => {
    expect(await askApproval(async () => { throw new Error("ui crashed"); }, req)).toBe("denied");
    expect(await askApproval((async () => "yes") as unknown as Approver, req)).toBe("denied");
    expect(await askApproval(fixedApprover(true), req)).toBe("approved");
  });

  it("broker: a UI resolves by id; late answers are ignored and reported as timeouts", async () => {
    const done: string[] = [];
    const b = approvalBroker({ onRequest: (r) => done.push(`asked ${r.id}`), onDone: (r, o) => done.push(`${r.id} ${o}`) });
    const p = askApproval(b.approver, req);
    await new Promise((r) => setImmediate(r));
    expect(b.pending().map((r) => r.id)).toEqual(["a1"]);
    expect(b.resolve("a1", true)).toBe(true);
    expect(await p).toBe("approved");
    expect(b.resolve("a1", false)).toBe(false);

    const late = await askApproval(b.approver, { ...req, id: "a2", timeoutMs: 20 });
    expect(late).toBe("timeout");
    expect(b.resolve("a2", true)).toBe(false);
    expect(done).toEqual(["asked a1", "a1 approved", "asked a2", "a2 timeout"]);
  });

  it("anyApprover: the first answer wins and the other approver learns the outcome", async () => {
    const done: string[] = [];
    const b = approvalBroker({ onDone: (r, o) => done.push(o) });
    const input = new PassThrough();
    const output = new PassThrough();
    const p = askApproval(anyApprover(b.approver, terminalApprover({ input, output })), req);
    await new Promise((r) => setImmediate(r));
    input.write("y\n");
    expect(await p).toBe("approved");
    expect(done).toEqual(["approved"]);
  });

  it("terminalApprover: anything but y denies", async () => {
    const input = new PassThrough();
    const p = askApproval(terminalApprover({ input, output: new PassThrough() }), req);
    await new Promise((r) => setImmediate(r));
    input.write("n\n");
    expect(await p).toBe("denied");
  });
});
