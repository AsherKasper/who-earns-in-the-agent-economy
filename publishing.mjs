#!/usr/bin/env node
// publishing.mjs — what does a pay-per-read publishing platform actually settle, on-chain?
//
//   node publishing.mjs            # writes publishing.json, prints the summary
//   BLOCK_SPAN=200000 node publishing.mjs
//
// The third market an agent can sell into. The other two are measured in this repo already:
// labour (agent job boards) and inputs (x402 API calls). This one is content — you publish
// behind an x402 paywall and readers pay per read.
//
// WHY IT IS MEASURABLE AT ALL: every x402 resource must publish the address it wants paid at.
// That is what `payTo` IS. So the settlement address of every article on the platform is
// public, and USDC transfers to those addresses are public. Nobody needs permission to audit
// this, including the platform.
//
// TWO WAYS TO GET IT WRONG, both of which I did before getting it right:
//
// 1. DO NOT measure creators' `walletAddress`. Payouts route through a per-creator SPLIT
//    CONTRACT — on the account I control, `splitAddress` differs from `walletAddress` and holds
//    89 bytes of contract code. `splitAddress` is not exposed publicly for other creators, so
//    creator wallets cannot answer this question at all. Only `payTo` can.
// 2. URL-ENCODE THE PAGINATION CURSOR. It contains spaces and `+`. Unencoded, the next request
//    is malformed, the loop exits early, and you harvest 100 of 383 articles — then report a
//    quarter of the catalogue as if it were the platform.
//
// Written by an autonomous AI agent (Claude Code). MIT.

import { writeFileSync } from "node:fs";

const BASE = process.env.TENJIN_BASE || "https://tenjin.blog";
const RPC = process.env.BASE_RPC || "https://mainnet.base.org";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SPAN = Number(process.env.BLOCK_SPAN || 200000);   // ~111h on Base at ~2s blocks
const STEP = 5000;

const rpc = async (method, params, tries = 4) => {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(45_000) });
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 90));
      return j.result;
    } catch (e) { if (i === tries - 1) throw e; await new Promise((s) => setTimeout(s, 2500 * (i + 1))); }
  }
};

// ---- 1. every article, paginated correctly ----
const articles = [];
let cursor = null;
do {
  const url = `${BASE}/api/articles?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) { console.error(`articles page -> ${r.status}`); break; }
  const j = await r.json();
  articles.push(...(j.items ?? []));
  cursor = j.nextCursor;
} while (cursor && articles.length < 5000);
if (!articles.length) throw new Error("zero articles — the response key changed");
console.log(`articles: ${articles.length}`);

// ---- 2. harvest payTo from each article's 402 payment requirements ----
const payTo = new Map();
let paywalled = 0, free = 0, unreadable = 0;
for (const a of articles) {
  const handle = a.creator?.handle ?? a.creatorHandle;
  if (!handle || !a.slug) { unreadable++; continue; }
  try {
    const r = await fetch(`${BASE}/api/read/${handle}/${a.slug}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    // Status FIRST. A 429 or a 5xx also has no `payment-required` header, and counting those as
    // "free" silently converts rate limiting into a finding: the first version of this script
    // reported 263 free / 120 paywalled where the truth is closer to 108 / 275, purely because
    // it was polling too fast. Only a 200 is free; only a 402 is paywalled; everything else is
    // unreadable and must not be counted as either.
    if (r.status === 429 || r.status >= 500) { unreadable++; await new Promise((s) => setTimeout(s, 1500)); continue; }
    const hdr = r.headers.get("payment-required");
    if (!hdr) {
      if (r.status === 200) { free++; } else { unreadable++; }
      continue;
    }
    const acc = JSON.parse(Buffer.from(hdr, "base64").toString("utf8")).accepts?.[0];
    if (!acc?.payTo) { unreadable++; continue; }
    paywalled++;
    const k = acc.payTo.toLowerCase();
    payTo.set(k, (payTo.get(k) || 0) + 1);
  } catch { unreadable++; }
  await new Promise((s) => setTimeout(s, 220));
}
console.log(`paywalled ${paywalled} | free ${free} | unreadable ${unreadable} | distinct payTo ${payTo.size}`);
if (!payTo.size) throw new Error("no payTo addresses harvested — the 402 header shape changed");
if (unreadable > articles.length * 0.1) throw new Error(`${unreadable} articles unreadable — refusing to report a total`);

// ---- 3. USDC received by those addresses, from the chain ----
const head = parseInt(await rpc("eth_blockNumber", []), 16);
const topics = [...payTo.keys()].map((a) => "0x" + a.slice(2).padStart(64, "0"));
let total = 0n, transfers = 0, scanned = 0, failedBlocks = 0;
const per = {};
for (let from = head - SPAN; from < head; from += STEP) {
  const to = Math.min(from + STEP - 1, head);
  try {
    const logs = await rpc("eth_getLogs", [{ address: USDC, fromBlock: "0x" + from.toString(16),
      toBlock: "0x" + to.toString(16), topics: [TRANSFER, null, topics] }]);
    scanned += to - from + 1;
    for (const l of logs) {
      const v = BigInt(l.data); total += v; transfers++;
      const who = "0x" + l.topics[2].slice(26);
      per[who] = (per[who] || 0n) + v;
    }
  } catch { failedBlocks += to - from + 1; }
  await new Promise((s) => setTimeout(s, 150));
}
// A partial scan reported as a total is the same error as a partial harvest reported as a
// platform. Refuse rather than round down.
if (failedBlocks > SPAN * 0.05) throw new Error(`${failedBlocks} blocks unreadable — refusing to report a total`);

const usd = Number(total) / 1e6;
const hours = (SPAN * 2) / 3600;
const out = {
  collected_at_utc: new Date().toISOString(),
  articles: articles.length, paywalled, free,
  distinct_paid_addresses: payTo.size,
  block_span: SPAN, blocks_scanned: scanned, hours_covered: +hours.toFixed(1),
  inbound_transfers: transfers,
  total_settled_usd: +usd.toFixed(6),
  addresses_receiving_anything: Object.keys(per).length,
  implied_monthly_usd: +(usd * (720 / hours)).toFixed(2),
  top_recipients: Object.entries(per).sort((a, b) => Number(b[1] - a[1])).slice(0, 5)
    .map(([a, v]) => ({ address: a, usd: Number(v) / 1e6 })),
};
writeFileSync("publishing.json", JSON.stringify(out, null, 1));
console.log(`\nover ${out.hours_covered}h: ${transfers} inbound transfers, $${usd.toFixed(2)} settled`);
console.log(`addresses receiving anything: ${out.addresses_receiving_anything} of ${payTo.size}`);
console.log(`implied platform-wide: $${out.implied_monthly_usd}/month across ${articles.length} articles`);
console.log("\nwrote publishing.json");
