#!/usr/bin/env node
// report — generate a DeFi protocol due-diligence report from public data, and emit the
// figures as JSON so every claim in the prose can be re-derived.
//
//   node report.mjs convex-finance
//
// Two traps this script exists to avoid, both hit while writing the first report:
//
// 1. THE SERIES CONTAINS DUPLICATE DATES. DefiLlama's tvl array had two rows dated
//    2026-08-18. Indexing "7 days ago" as `arr[len-8]` therefore landed on the wrong day and
//    produced -2.5% where the true figure was -21.5% — a tenfold error, in the direction that
//    makes a collapsing protocol look stable. Everything here is indexed BY DATE.
//
// 2. `audits: "0"` DOES NOT MEAN UNAUDITED. It means DefiLlama holds no audit link. BlackRock
//    BUIDL, Circle USYC and Coinbase Bridge all carry "0". Reporting those as unaudited would
//    be false about real institutions. The field is reported as what it is — a data-coverage
//    flag — and never as a security finding.
//
// Written by an autonomous AI agent (Claude Code). MIT.

import { writeFileSync } from "node:fs";

const slug = process.argv[2] || "convex-finance";
const get = async (u) => {
  const r = await fetch(u, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(40_000) });
  if (!r.ok) throw new Error(`${u} -> ${r.status}`);
  return r.json();
};

const p = await get(`https://api.llama.fi/protocol/${slug}`);
const list = await get("https://api.llama.fi/protocols");
const listed = list.find((x) => x.slug === slug || x.name === p.name);

// --- Build a date-keyed series, keeping the LAST value for any duplicated date.
const byDate = new Map();
for (const row of p.tvl ?? []) {
  const d = new Date(row.date * 1000).toISOString().slice(0, 10);
  byDate.set(d, row.totalLiquidityUSD);
}
const dates = [...byDate.keys()].sort();
const dupes = (p.tvl?.length ?? 0) - dates.length;
const latest = dates[dates.length - 1];
const val = (d) => byDate.get(d);

const daysBefore = (iso, n) => {
  const t = new Date(iso + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() - n);
  return t.toISOString().slice(0, 10);
};
// Walk back to the nearest date we actually hold, so a gap cannot silently shift the window.
const nearest = (iso) => {
  for (let i = 0; i <= 10; i++) {
    const c = daysBefore(iso, i);
    if (byDate.has(c)) return c;
  }
  return null;
};
const change = (n) => {
  const from = nearest(daysBefore(latest, n));
  if (!from) return null;
  const a = val(from), b = val(latest);
  return { from, from_usd: a, to: latest, to_usd: b, pct: a ? ((b - a) / a) * 100 : null };
};

const peakDate = dates.reduce((a, d) => (val(d) > val(a) ? d : a), dates[0]);

// Largest single-day move in the last 30 days — the event, if there is one.
const recent = dates.slice(-31);
let biggestDay = null;
for (let i = 1; i < recent.length; i++) {
  const a = val(recent[i - 1]), b = val(recent[i]);
  if (!a) continue;
  const pct = ((b - a) / a) * 100;
  if (!biggestDay || Math.abs(pct) > Math.abs(biggestDay.pct)) biggestDay = { date: recent[i], prev: recent[i - 1], from_usd: a, to_usd: b, pct };
}

const out = {
  protocol: p.name,
  slug,
  category: p.category,
  chains: p.chains,
  generated_at_utc: new Date().toISOString(),
  tvl_now_usd: val(latest),
  as_of: latest,
  series_points: p.tvl?.length ?? 0,
  duplicate_dated_rows: dupes,
  change: { d7: change(7), d30: change(30), d90: change(90), d365: change(365) },
  peak: { date: peakDate, usd: val(peakDate), drawdown_pct: ((val(latest) - val(peakDate)) / val(peakDate)) * 100 },
  biggest_single_day_30d: biggestDay,
  chain_tvl: Object.fromEntries(Object.entries(p.currentChainTvls ?? {}).sort((a, b) => b[1] - a[1])),
  audits_field: p.audits ?? null,
  audit_links: p.audit_links ?? null,
  audits_field_meaning: "DefiLlama data-coverage flag, NOT a security assessment. '0' means no audit link is recorded here; it does not mean the protocol is unaudited.",
  listed_change_7d: listed?.change_7d ?? null,
  cross_check: null,
};

// Cross-check our own arithmetic against DefiLlama's own change_7d. If these disagree by more
// than a point, one of them is wrong and the report must say so rather than pick the nicer one.
if (out.change.d7 && typeof out.listed_change_7d === "number") {
  const diff = Math.abs(out.change.d7.pct - out.listed_change_7d);
  out.cross_check = {
    ours_pct: out.change.d7.pct, theirs_pct: out.listed_change_7d, abs_diff: diff,
    agrees: diff < 1.0,
  };
}

writeFileSync("figures.json", JSON.stringify(out, null, 1));
console.log(`${out.protocol} — $${(out.tvl_now_usd / 1e6).toFixed(1)}M as of ${out.as_of}`);
console.log(`  duplicate-dated rows in series: ${dupes}`);
for (const [k, c] of Object.entries(out.change)) if (c) console.log(`  ${k.padEnd(5)} ${c.pct.toFixed(1).padStart(7)}%  (${c.from} $${(c.from_usd / 1e6).toFixed(1)}M -> ${c.to} $${(c.to_usd / 1e6).toFixed(1)}M)`);
console.log(`  peak $${(out.peak.usd / 1e6).toFixed(1)}M on ${out.peak.date} — drawdown ${out.peak.drawdown_pct.toFixed(1)}%`);
if (biggestDay) console.log(`  biggest 1d move in 30d: ${biggestDay.pct.toFixed(1)}% on ${biggestDay.date}`);
console.log(`  cross-check vs DefiLlama change_7d: ${out.cross_check ? (out.cross_check.agrees ? "AGREES" : `DISAGREES by ${out.cross_check.abs_diff.toFixed(1)} points`) : "n/a"}`);
console.log("\nwrote figures.json");
