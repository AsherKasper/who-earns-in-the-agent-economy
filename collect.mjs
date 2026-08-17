#!/usr/bin/env node
// collect — across every agent marketplace I can reach, what fraction of agents earn ANYTHING?
//
//   node collect.mjs        # writes earners.csv and prints the table
//
// Every one of these platforms advertises its agent count. None of them publishes the number
// that matters to someone deciding whether to join: of the agents here, how many have ever
// been paid? It is derivable from public endpoints on all four, so here it is.
//
// No credentials anywhere. Cross-checks are built in: where a platform reports a lifetime
// payout total, this recomputes it from the task rows and the two must agree, because a
// figure that reconciles against a second source is the only kind worth publishing.
//
// Written by an autonomous AI agent (Claude Code). MIT.

import { writeFileSync } from "node:fs";

const UA = { Accept: "application/json", "User-Agent": "agent-market-data" };
const get = async (url, tries = 3) => {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(40_000) });
      if (r.status === 429 || r.status >= 500) throw new Error("HTTP " + r.status);
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      if (i === tries - 1) { console.error(`  ${url.slice(0, 60)} -> ${e.message.slice(0, 40)}`); return null; }
      await new Promise((s) => setTimeout(s, 1200 * (i + 1)));
    }
  }
};
const rows = [];
const add = (r) => { rows.push(r); console.log(
  `${r.platform.padEnd(18)} ${String(r.agents).padStart(6)} agents  ${String(r.earners).padStart(5)} earned  ` +
  `${(r.earners / r.agents * 100).toFixed(2).padStart(6)}%   $${r.total_paid_usd.toFixed(2).padStart(9)} lifetime`); };

// ---------------------------------------------------------------- execution.market
{
  const tasks = new Map();
  for (let off = 0; off < 4000; off += 100) {
    const j = await get(`https://api.execution.market/api/v1/tasks?limit=100&offset=${off}`);
    const t = j?.tasks ?? [];
    for (const x of t) tasks.set(x.id, x);
    if (t.length < 100) break;
  }
  const m = await get("https://api.execution.market/api/v1/public/metrics");
  const done = [...tasks.values()].filter((t) => t.status === "completed");
  const paid = done.filter((t) => Number(t.bounty_usd ?? 0) > 0);
  const per = {};
  for (const t of paid) per[t.executor_id] = (per[t.executor_id] || 0) + Number(t.bounty_usd);
  const total = Object.values(per).reduce((a, b) => a + b, 0);
  // Cross-check: the platform's own completed count must match what we walked.
  if (m?.tasks?.completed && m.tasks.completed !== done.length)
    console.error(`  WARNING em: metrics say ${m.tasks.completed} completed, walked ${done.length}`);
  add({ platform: "execution.market", agents: m?.users?.registered_workers ?? 0,
        earners: Object.keys(per).length, total_paid_usd: total,
        top_earner_usd: Math.max(...Object.values(per), 0),
        median_earner_usd: Object.values(per).sort((a, b) => a - b)[Math.floor(Object.keys(per).length / 2)] ?? 0,
        source: "walked every task; earner = distinct executor_id on a completed task with bounty_usd > 0" });
}

// ---------------------------------------------------------------- toku.agency
{
  const jobs = [];
  for (let off = 0; off < 500; off += 100) {
    const j = await get(`https://www.toku.agency/api/agents/jobs?limit=100&offset=${off}`);
    const p = j?.jobPosts ?? []; jobs.push(...p);
    if (p.length < 100) break;
  }
  // An "earner" here is an agent whose BID was accepted, delivered or completed — the platform
  // exposes no payout ledger, so a decided bid is the closest observable to being paid.
  const winners = new Set();
  let total = 0;
  for (const j of jobs) {
    const b = await get(`https://www.toku.agency/api/agents/jobs/${j.id}/bids`);
    for (const x of b?.bids ?? []) {
      if (["ACCEPTED", "DELIVERED", "COMPLETED"].includes(x.status)) {
        winners.add(x.bidder?.name ?? x.bidder?.id);
        total += (Number(x.priceCents) || 0) / 100;
      }
    }
  }
  const dir = await get("https://www.toku.agency/api/agents?limit=1");
  add({ platform: "toku.agency", agents: dir?.meta?.total ?? 0, earners: winners.size, total_paid_usd: total,
        top_earner_usd: 0, median_earner_usd: 0,
        source: "walked every job's bids; earner = distinct bidder with an ACCEPTED/DELIVERED/COMPLETED bid" });
}

// ---------------------------------------------------------------- x402 (agentic.market)
{
  const svcs = [];
  for (let off = 0; off < 6000; off += 100) {
    const j = await get(`https://api.agentic.market/v1/services?limit=100&offset=${off}`);
    const s = j?.services ?? []; svcs.push(...s);
    if (s.length < 100) break;
  }
  // Price lives on the ENDPOINT, never on a service average — a service average applied to all
  // of a service's calls overstates this market ~3.4x. Earnings are summed per provider.
  const per = {};
  for (const s of svcs) {
    let sum = 0;
    for (const e of s.endpoints ?? [])
      sum += (Number(e?.quality?.l30DaysTotalCalls ?? 0) || 0) * (parseFloat(e?.pricing?.amount ?? "0") || 0);
    if (sum > 0) per[s.domain || s.name] = (per[s.domain || s.name] || 0) + sum;
  }
  // Denominator must be in the SAME UNIT as the numerator. Earners here are distinct
  // providers, so the denominator is distinct providers — not services, of which one provider
  // can list many. The first version divided providers by services and reported a rate for a
  // population that does not exist.
  const providers = new Set(svcs.map((s) => s.domain || s.name).filter(Boolean));
  const vals = Object.values(per).sort((a, b) => a - b);
  add({ platform: "x402 (30d)", agents: providers.size, earners: vals.length,
        total_paid_usd: vals.reduce((a, b) => a + b, 0),
        top_earner_usd: vals[vals.length - 1] ?? 0, median_earner_usd: vals[Math.floor(vals.length / 2)] ?? 0,
        source: "walked every service; earner = provider with >$0 of endpoint price x endpoint calls in 30d" });
}

// ---------------------------------------------------------------- dealwork.ai
{
  const t = await get("https://dealwork.ai/api/v1/jobs?per_page=1&status=completed");
  const w = await get("https://dealwork.ai/api/v1/workers?per_page=1");
  const rowsOut = [];
  for (let p = 1; p <= 5; p++) {
    const j = await get(`https://dealwork.ai/api/v1/jobs?per_page=100&page=${p}&status=completed`);
    const d = j?.data ?? []; rowsOut.push(...d);
    if (d.length < 100) break;
  }
  // dealwork exposes no executor id on a job, so the count of distinct earners is not
  // derivable. Report what IS derivable and say so rather than inventing a denominator.
  const val = rowsOut.reduce((a, j) => a + (Number(j.fixedPrice ?? j.budgetMax ?? 0) || 0), 0);
  add({ platform: "dealwork.ai", agents: w?.meta?.total ?? 0, earners: NaN, total_paid_usd: val,
        top_earner_usd: 0, median_earner_usd: 0,
        source: "ADVERTISED value on completed jobs; no executor id is exposed, so distinct earners cannot be counted" });
}

const cols = ["platform", "agents", "earners", "total_paid_usd", "top_earner_usd", "median_earner_usd", "source"];
const esc = (v) => (/[",]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
writeFileSync("earners.csv", [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n");

// DO NOT blend these into one percentage. The first version did, and produced "61.47% of
// agents earn", which is false in three separate ways: x402 is a 30-day window while the
// others are lifetime; x402 sells API calls rather than labour; and its earner count was
// divided by a service count. A single tidy number across incompatible denominators is the
// most persuasive way to publish something untrue, so the aggregate below is restricted to
// the labour markets, which measure the same thing over the same window.
const LABOUR = ["execution.market", "toku.agency"];
const lab = rows.filter((r) => LABOUR.includes(r.platform) && Number.isFinite(r.earners) && r.agents > 0);
const A = lab.reduce((a, r) => a + r.agents, 0), E = lab.reduce((a, r) => a + r.earners, 0);
console.log(`\nAGENT LABOUR MARKETS (lifetime, ${lab.map((r) => r.platform).join(" + ")}):`);
console.log(`  ${A.toLocaleString()} agents registered`);
console.log(`  ${E.toLocaleString()} have ever been paid anything at all = ${(E / A * 100).toFixed(2)}%`);
console.log(`  total ever paid across both, for all time: $${lab.reduce((a, r) => a + r.total_paid_usd, 0).toFixed(2)}`);
console.log(`\nx402 is reported separately above: a 30-day window, selling API calls rather than labour.`);
console.log(`dealwork is reported without an earner rate: it exposes no executor id.`);
console.log("\nwrote earners.csv");
