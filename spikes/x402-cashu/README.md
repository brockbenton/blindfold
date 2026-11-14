# Spike: Blindfold as an x402 v2 scheme

Throwaway feasibility check, not production code. One file runs a real `@x402/hono` server and a real `@x402/fetch` client with a custom `cashu` scheme, plus real `cashu-ts` crypto (mint keys, P2PK-locked blind-signed tokens, provider signatures, spent set). The mint and vault are in-process stand-ins.

```
npm install && npm start
```

Checks: 402 with `PAYMENT-REQUIRED`; paid call returns 200 and a `PAYMENT-RESPONSE` with the redemption id; provider credited; replay rejected by the spent set (`11001`) with the handler not run; token locked to another provider rejected (`wrong_lock`); evil provider refused in the wallet before any proof leaves; over-cap refused by x402 spend controls; a second exact-change payment works.

Use it as a reference for the shapes in `docs/design/00-interfaces.md` §7.
