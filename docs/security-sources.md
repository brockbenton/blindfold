# Security references

These references provide background on x402 and Cashu. They are not a security audit of Blindfold, and findings about another implementation do not establish that this one is safe.

## External reading

- [Cashu NUTs](https://cashubtc.github.io/nuts/): token encoding, keysets, P2PK locks, DLEQ and quote signatures. Blindfold implements a subset plus a custom `solana-usdc` mint method; see [the interface contract](design/00-interfaces.md).
- [x402 specification](https://github.com/x402-foundation/x402): payment requirements, payloads and HTTP transport. Blindfold uses its v2 SDKs with a custom `blindfold` scheme.
- [Wang et al., “When HTTP 402 Meets the Blockchain: Risks on Emerging x402 Payments”](https://arxiv.org/abs/2607.19545): facilitator security research. Check the paper's version, scope and tested implementations before quoting counts or generalizing its results.
- [Cloud Security Alliance research note](https://labs.cloudsecurityalliance.org/research/csa-research-note-x402-agent-payment-sdk-flaws-20261025-csa/) and [Safeguard coverage](https://safeguard.sh/resources/blog/x402-protocol-25-vulnerabilities-ai-agent-payments): secondary discussions of V12's x402 findings. Verify the primary report and affected versions before quoting vulnerability counts, disclosure dates or patch status.
- [Cashu privacy FAQ](https://docs.cashu.space/faq) and [Oblivious HTTP](https://www.rfc-editor.org/rfc/rfc9458.html): privacy background. Blindfold does not implement a relay or OHTTP.

## What the implementation checks

- Wallet price, asset, mint and provider checks run before sending proofs. The per-call cap is a code policy. The token budget and provider signatures supply separate constraints, but a compromised agent can still spend its entire budget at allowed providers.
- The mint confirms deposits from vault-owned account state rather than interpreting transfer-like instructions. This avoids relying on an instruction parser as evidence that funds arrived.
- The mint inserts spent proofs and credits provider balances in one database transaction. Settlement batches use monotonically increasing IDs to reject replay.
- The provider redeems before serving data. This prevents an unspent-looking token from buying data twice, but a lost response can leave a paid customer without data.
- The agent's reserve check fails closed on errors. With the onchain issuance log it uses the mint's public, non-decreasing claim, so the mint cannot report a smaller number than it logged; a dishonest mint can still issue tokens it never logs.

These controls have tests; none justifies claims that funds cannot be drained, activity cannot be watched, or a leaked token is useless. The mint is custodial, signing helpers are non-constant-time, and deployment authorities remain trusted. See [security model and limitations](../README.md#security-model-and-limitations).
