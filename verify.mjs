#!/usr/bin/env node
// verify — re-derive every number in README.md from earners.csv. Exits 1 on any mismatch.
//
// Add new checks ABOVE the summary block at the bottom; the exit code must be the last thing
// this file sets, or a failing check prints FAIL and still passes the build.
//
// Written by an autonomous AI agent (Claude Code). MIT.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const lines = readFileSync(join(HERE, "earners.csv"), "utf8").trim().split(/\r?\n/);
const cols = lines[0].split(",");
const parse = (l) => {
  const out = []; let cur = "", q = false;
  for (const ch of l) {
    if (ch === '"') { q = !q; continue; }
    if (ch === "," && !q) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return Object.fromEntries(cols.map((k, i) => [k, out[i]]));
};
const rows = lines.slice(1).map(parse);
const flat = (s) => s.replace(/\s+/g, " ");
const readme = flat(readFileSync(join(HERE, "README.md"), "utf8"));

let bad = 0;
const check = (label, actual, mustAppear) => {
  const ok = readme.includes(flat(mustAppear));
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${actual}${ok ? "" : `  — README lacks "${mustAppear}"`}`);
  if (!ok) bad++;
};
const at = (p) => rows.find((r) => r.platform === p);
const n = (r, k) => Number(r[k]) || 0;
const fmt = (x) => x.toLocaleString("en-US");

const em = at("execution.market"), tk = at("toku.agency"), x4 = at("x402 (30d)"), dw = at("dealwork.ai");

check("em agents", n(em, "agents"), `| execution.market | ${fmt(n(em, "agents"))} |`);
check("em earners", n(em, "earners"), `| ${fmt(n(em, "earners"))} | **${(100 * n(em, "earners") / n(em, "agents")).toFixed(2)}%**`);
check("em paid", n(em, "total_paid_usd"), `$${n(em, "total_paid_usd").toFixed(2)} |`);
check("em top earner", n(em, "top_earner_usd"), `**$${n(em, "top_earner_usd").toFixed(2)}**`);
check("em median earner", n(em, "median_earner_usd"), `**$${n(em, "median_earner_usd").toFixed(2)}**`);

check("toku agents", n(tk, "agents"), `| toku.agency | ${fmt(n(tk, "agents"))} |`);
check("toku earners", n(tk, "earners"), `${fmt(n(tk, "earners"))} agents have ever had a bid decided, out of ${fmt(n(tk, "agents"))}`);

// The headline. Restricted to the labour markets on purpose; see the README.
const A = n(em, "agents") + n(tk, "agents"), E = n(em, "earners") + n(tk, "earners");
const P = n(em, "total_paid_usd") + n(tk, "total_paid_usd");
check("labour agents", A, `**${fmt(A)}**`);
check("labour earners", E, `**${fmt(E)}**`);
check("labour rate", `${(100 * E / A).toFixed(2)}%`, `**${(100 * E / A).toFixed(2)}%**`);
check("labour total paid", `$${P.toFixed(2)}`, `**$${P.toFixed(2)}**`);
check("headline in title", `${fmt(A)} / ${E}`, `# ${fmt(A)} agents are registered to do paid work. ${E} have ever been paid.`);

check("x402 providers", n(x4, "agents"), `| participants | ${fmt(A)} | ${fmt(n(x4, "agents"))} |`);
check("x402 earners", n(x4, "earners"), `${fmt(n(x4, "earners"))} (**${(100 * n(x4, "earners") / n(x4, "agents")).toFixed(2)}%**)`);
check("x402 paid 30d", n(x4, "total_paid_usd"), `**$${n(x4, "total_paid_usd").toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}**`);

// The 175x claim is derived, so it must be recomputed rather than trusted.
const ratio = n(x4, "total_paid_usd") / P;
check("x402 : labour ratio", `${ratio.toFixed(1)}x`, `**${Math.round(ratio)}×**`);

check("dealwork advertised", n(dw, "total_paid_usd"), `$${n(dw, "total_paid_usd").toFixed(2)} is *advertised* value`);

// dealwork must NOT carry an earner rate — it exposes no executor id, and inventing one is the
// exact failure this repo is about.
const dwHasRate = Number.isFinite(Number(dw.earners)) && dw.earners !== "NaN" && dw.earners !== "";
console.log(`${dwHasRate ? "FAIL" : "PASS"}  dealwork has no earner rate: earners=${JSON.stringify(dw.earners)}`);
if (dwHasRate) bad++;

console.log(bad ? `\n${bad} claim(s) not supported by earners.csv.` : "\nEvery number in the README re-derives from earners.csv.");
process.exitCode = bad ? 1 : 0;
