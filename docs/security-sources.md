# Blindfold: Security sources

The x402 security research we cite. Pitch is in [`README.md`](../README.md).

## Wang et al., "When HTTP 402 Meets the Blockchain: Risks on Emerging x402 Payments"

[arXiv 2607.19545](https://arxiv.org/abs/2607.19545). Published 21 July 2026, accepted to USENIX Security 2026. EPFL and Zhejiang University.

- First systematic security study of real-world x402 **facilitators**.
- 49 security rule violations, amounting to 31 previously unknown vulnerabilities.
- Every facilitator tested broke at least one rule, and every rule was broken by at least one platform.
- Four new attacks: Free Shopping, Asset Theft, Service Denial, Gas Abuse.
- Secondary write-ups say 15 facilitators were tested. **Not confirmed in the paper; don't quote the number.**

## V12, "25 Vulnerabilities in the x402 Protocol"

V12 blog post (summarized from V12's own post).

- 25 vulnerabilities. Reported 3 critical and 13 high on **August 12, 2026**, then 9 medium/low on September 9.
- The 3 criticals were fixed by **August 20, 2026**.
- **Critical 1, no spending limit:** the documented default client enforced no per-payment limit and no total budget. It picked the first payment option and passed the server's amount, token and recipient straight to signing. A hostile API could request the wallet's full balance of a compatible token with no separate approval prompt. An earlier small payment could reveal the wallet address so the server could check the balance first.
- **Critical 2, Solana payment bypass:** the Solana facilitator parsed an `ApproveChecked` instruction as if it were a `TransferChecked` (they differ only in the first byte). A merchant could deliver a paid resource while receiving no tokens, and the facilitator paid the fee.
- **Critical 3, login signature for another site:** the Sign-In-With-X client signed login messages without checking that the domain matched the site contacted, so a hostile server could log in elsewhere as the client's wallet.
- Conclusion: payment clients should enforce explicit per-payment and total budgets; "optional policies only protect applications that actually enable them."

Coverage: [Cloud Security Alliance research note](https://labs.cloudsecurityalliance.org/research/csa-research-note-x402-agent-payment-sdk-flaws-20261025-csa/) (25 October 2026; says the spending-limit flaw has the widest consequences because it reverses who decides the payment amount) and [Safeguard](https://safeguard.sh/resources/blog/x402-protocol-25-vulnerabilities-ai-agent-payments).

## How we use this

- **The drain flaw is our hook.** A hostile server could empty an x402 agent's wallet. The patch is a spending limit in client code, which a bug or a compromised agent can get around. In Blindfold the agent holds no key and no USDC, only tokens that allowlisted providers alone can redeem, so there is nothing to drain. Show this live in the prompt injection demo.
- **Say "patched in code, not in structure."** Don't present it as an open bug, and don't date it October (that's the CSA write-up, not the report).
- **Careful with the facilitator findings.** Blindfold uses no third-party facilitator, but our mint does a similar job, so we avoid those bugs by design rather than fix them. Critical 2 is a direct warning for us: the mint must confirm deposits from the vault program's own state, never by loosely parsing raw instructions.
- **Never claim Blindfold fixes x402 security in general.**
