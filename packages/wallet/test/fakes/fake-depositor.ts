import type { Depositor } from "../../src/depositor.js";
import type { FakeMint } from "./fake-mint.js";

export class FakeDepositor implements Depositor {
  calls: { amountCents: number; depositRef: string }[] = [];
  constructor(private mint: FakeMint) {}
  async deposit(a: { amountCents: number; depositRef: Uint8Array }) {
    const ref = Buffer.from(a.depositRef).toString("hex");
    this.calls.push({ amountCents: a.amountCents, depositRef: ref });
    this.mint.markPaid(ref, a.amountCents);
    return { signature: `fake-sig-${this.calls.length}` };
  }
}
