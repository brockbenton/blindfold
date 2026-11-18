// QuickNode Streams filter for the observer (network solana-devnet, dataset block). QuickNode runs main() on every block
// batch. It keeps only successful transactions that move USDC into a watched token account (the data feed's
// payout account or the Blindfold vault) and returns one compact record per movement, plus the vault's DepositMade
// events. Every batch returns { tip }, even with no records, so the receiver knows the Stream is alive and how far
// it has read.
//
// scripts/lib/streams.ts replaces the WATCH line with the real addresses before uploading (scripts/streams-setup.ts).
// Plain ES2017 with no dependencies: it runs in QuickNode's filter sandbox and in the tests.
const WATCH = { tokenAccounts: [], vaultToken: "", vaultProgram: "", usdcMint: "" }; // @watch

const MEMO_PROGRAMS = ["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"];
const DEPOSIT_MADE = "d2c982b7f4cb9bc7"; // sha256("event:DepositMade")[0..8]

function main(stream) {
  const blocks = Array.isArray(stream.data) ? stream.data : [stream.data];
  const records = [];
  const deposits = [];
  let tip = 0;
  for (const block of blocks) {
    if (!block) continue;
    tip = Math.max(tip, block.slot || 0);
    for (const tx of block.transactions || []) {
      if (!tx || !tx.meta || tx.meta.err) continue;
      const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
      const signature = tx.transaction.signatures[0];
      const base = { signature, slot: block.slot, time: block.blockTime || null };
      for (const account of WATCH.tokenAccounts) {
        const m = movement(tx, keys, account);
        if (!m) continue;
        const memo = memoOf(tx);
        records.push(Object.assign({}, base, { account }, m, memo === undefined ? {} : { memo }));
      }
      if (keys.indexOf(WATCH.vaultProgram) >= 0) {
        for (const line of tx.meta.logMessages || []) {
          const d = line.indexOf("Program data: ") === 0 ? depositMade(line.slice(14)) : null;
          if (d) deposits.push(Object.assign({}, base, d));
        }
      }
    }
  }
  return { tip, records, deposits };
}

// USDC arriving at `account`, from balance deltas (works for any instruction layout). Mirrors movements() in
// scripts/lib/bot.ts so a Stream record and an RPC poll describe a transaction the same way.
function movement(tx, keys, account) {
  const wi = keys.indexOf(account);
  if (wi < 0) return null;
  const pre = (tx.meta.preTokenBalances || []).filter((b) => b.mint === WATCH.usdcMint);
  const post = (tx.meta.postTokenBalances || []).filter((b) => b.mint === WATCH.usdcMint);
  const find = (list, i) => list.find((b) => b.accountIndex === i);
  const amt = (b) => BigInt(b ? b.uiTokenAmount.amount : "0");
  const delta = (i) => amt(find(post, i)) - amt(find(pre, i));
  const received = delta(wi);
  if (received <= 0n) return null;
  const indexes = [];
  for (const b of pre.concat(post)) if (indexes.indexOf(b.accountIndex) < 0) indexes.push(b.accountIndex);
  const si = indexes.find((i) => i !== wi && delta(i) < 0n);
  if (si === undefined) return null;
  const owner = (i) => { const b = find(pre, i) || find(post, i); return b && b.owner ? b.owner : keys[i]; };
  const toBalance = find(post, wi);
  return {
    sender: owner(si), senderAccount: keys[si], recipient: toBalance && toBalance.owner ? toBalance.owner : keys[wi],
    amount: received.toString(),
  };
}

function memoOf(tx) {
  for (const ix of tx.transaction.message.instructions || []) {
    if (MEMO_PROGRAMS.indexOf(ix.programId) >= 0 && typeof ix.parsed === "string") return ix.parsed;
  }
  return undefined;
}

// DepositMade { index: u64, depositor: Pubkey, amount: u64, deposit_ref: [u8; 32] }, Borsh after the discriminator.
function depositMade(b64) {
  const b = fromBase64(b64);
  if (b.length !== 88 || hex(b.slice(0, 8)) !== DEPOSIT_MADE) return null;
  return { index: u64(b, 8).toString(), depositor: base58(b.slice(16, 48)), amount: u64(b, 48).toString(), depositRef: hex(b.slice(56, 88)) };
}

function u64(b, at) {
  let n = 0n;
  for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(b[at + i]);
  return n;
}

function hex(b) {
  let s = "";
  for (const x of b) s += (x < 16 ? "0" : "") + x.toString(16);
  return s;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function fromBase64(s) {
  const out = [];
  let bits = 0;
  let acc = 0;
  for (const c of s) {
    const v = B64.indexOf(c);
    if (v < 0) continue; // padding
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); }
  }
  return out;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let n = 0n;
  for (const x of bytes) n = n * 256n + BigInt(x);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of bytes) { if (x !== 0) break; s = "1" + s; }
  return s;
}
