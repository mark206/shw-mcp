// Cross-platform test runner (Windows/Mac/Linux). Needs Node 18+.
// Usage:  node test/run.mjs <C7_APP_SECRET> [from] [to]
import { writeFileSync } from 'fs';
const [secret, from = '2026-10-01', to = '2026-10-31'] = process.argv.slice(2);
if (!secret) { console.error('Usage: node test/run.mjs <C7_APP_SECRET> [from] [to]'); process.exit(1); }
process.env.C7_APP_SECRET = secret;
process.env.PORT = '3999';
await import('../server.js');
await new Promise(r => setTimeout(r, 1500));
const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_sales', arguments: { from_date: from, to_date: to, wine_only: false, include_raw_sample: true } } };
const r = await fetch('http://localhost:3999', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const j = await r.json();
const out = j.result?.content?.[0]?.text ?? JSON.stringify(j, null, 2);
writeFileSync('shw-test-output.json', out);
console.log('Done. Wrote shw-test-output.json in this folder.');
process.exit(0);
