import { mkdirSync, writeFileSync } from 'node:fs';
import { buildReport, renderMarkdown } from './balance-lib.js';

const t0 = Date.now();
const report = buildReport(Number(process.env.TRIALS ?? 20));
mkdirSync('docs', { recursive: true });
writeFileSync('docs/balance-report.json', JSON.stringify(report, null, 2) + '\n');
writeFileSync('docs/balance-report.md', renderMarkdown(report));
const failed = report.checks.filter((c) => !c.pass);
console.log(`balance report written in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${report.checks.length} checks, ${failed.length} failed`);
for (const f of failed) console.log(`FAIL ${f.name}: ${f.detail}`);
process.exit(failed.length ? 1 : 0);
