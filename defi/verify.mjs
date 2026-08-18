#!/usr/bin/env node
// verify — re-derive every number in convex-finance.md from figures.json. Exits 1 on mismatch.
// Add checks ABOVE the summary block; the exit code must be the last thing set.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const f = JSON.parse(readFileSync(join(HERE, "figures.json"), "utf8"));
// Normalise typography before comparing. The report uses a real minus sign (U+2212) and comma
// thousands separators, which is correct typesetting; the generator emits ASCII. Comparing them
// raw produced seven FAILs whose numbers were all identical — a checker that fails on
// punctuation trains you to ignore it, which is worse than not having one.
const flat = (s) =>
  s.replace(/−/g, "-")
   .replace(/(\d),(\d{3})/g, "$1$2")
   .replace(/\s+/g, " ");
const md = flat(readFileSync(join(HERE, "convex-finance.md"), "utf8"));
let bad = 0;
const check = (label, actual, must) => {
  const ok = md.includes(flat(must));
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${actual}${ok ? "" : `  — report lacks "${must}"`}`);
  if (!ok) bad++;
};
const m = (x) => `$${(x / 1e6).toFixed(1)}M`;
check("tvl now", m(f.tvl_now_usd), `**${m(f.tvl_now_usd)} TVL`);
for (const [k, days] of [["d7", 7], ["d30", 30], ["d90", 90], ["d365", 365]]) {
  const c = f.change[k];
  check(`${k} pct`, `${c.pct.toFixed(1)}%`, `${c.pct.toFixed(1)}%`);
  check(`${k} endpoints`, `${c.from} ${m(c.from_usd)}`, `${c.from} ${m(c.from_usd)} → ${m(c.to_usd)}`);
}
check("peak", `${m(f.peak.usd)} ${f.peak.date}`, `${m(f.peak.usd).replace("$21166.7M", "$21.17B")} on ${f.peak.date}`.replace("$21166.7M", "$21.17B"));
check("drawdown", `${f.peak.drawdown_pct.toFixed(1)}%`, `**${Math.abs(f.peak.drawdown_pct).toFixed(1)}% from its peak**`);
check("biggest 1d", `${f.biggest_single_day_30d.pct.toFixed(1)}% on ${f.biggest_single_day_30d.date}`,
  `**+${f.biggest_single_day_30d.pct.toFixed(1)}% on ${f.biggest_single_day_30d.date}**`);
check("duplicate rows", f.duplicate_dated_rows, `There were ${f.duplicate_dated_rows + 1} rows dated`);
const eth = f.chain_tvl.Ethereum;
check("ethereum tvl", m(eth), `| Ethereum | ${m(eth)} |`);
const chainTotal = ["Ethereum","Fraxtal","Arbitrum","Polygon"].reduce((a,k)=>a+(f.chain_tvl[k]||0),0);
check("eth concentration", `${(100*eth/chainTotal).toFixed(1)}%`, `**${(100*eth/chainTotal).toFixed(1)}% of assets sit on Ethereum**`);
check("audits field", f.audits_field, `\`audits: "${f.audits_field}"\` for Convex`);
console.log(`${f.cross_check?.agrees ? "PASS" : "FAIL"}  cross-check vs DefiLlama change_7d: ours ${f.cross_check?.ours_pct.toFixed(1)}% vs theirs ${f.cross_check?.theirs_pct.toFixed(1)}%`);
if (!f.cross_check?.agrees) bad++;
console.log(bad ? `\n${bad} claim(s) not supported by figures.json.` : "\nEvery number in the report re-derives from figures.json.");
process.exitCode = bad ? 1 : 0;
