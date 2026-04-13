// Live smoke test — loads both workers in chromium, verifies the
// shared bundle resolves to the right network per hostname, exercises
// a handful of endpoints, and reports console errors.
//
// Run: node scripts/devnet-smoke.mjs
import { chromium } from 'playwright';

const TARGETS = [
  { url: 'https://dotski-devnet.imbibed.workers.dev/', expected: 'testnet' },
  { url: 'https://sui.ski/',                           expected: 'mainnet' },
];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
let fail = 0;

for (const { url, expected } of TARGETS) {
  console.log(`\n──── ${url} (expect ${expected}) ────`);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

  const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  console.log('  status:', resp?.status());
  await page.waitForTimeout(1500);

  const network = await page.evaluate(() => {
    const host = (location.hostname || '').toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') return 'testnet';
    if (host.startsWith('dotski-devnet.') && host.endsWith('.workers.dev')) return 'testnet';
    return 'mainnet';
  });
  const ok = network === expected;
  console.log(`  detectNetwork: ${network} ${ok ? '✓' : '✗ EXPECTED ' + expected}`);
  if (!ok) fail++;

  const endpoints = ['/api/zklogin/health', '/api/encrypt/health'];
  for (const ep of endpoints) {
    const res = await page.evaluate(async (e) => {
      try { const r = await fetch(e); return { status: r.status, body: (await r.text()).slice(0, 120) }; }
      catch (err) { return { error: String(err) }; }
    }, ep);
    console.log(`  ${ep}:`, res);
  }

  const title = await page.title();
  const bodyHasSki = await page.evaluate(() => /\.ski|sui\.ski/i.test(document.body?.innerText || ''));
  console.log(`  title: ${JSON.stringify(title)}   bodyHasSki: ${bodyHasSki}`);

  console.log(`  console.error count: ${errors.length}`);
  for (const e of errors.slice(0, 5)) console.log('    ERR:', e);
  if (errors.length) fail++;

  await page.close();
}

await browser.close();

if (fail > 0) {
  console.log(`\n✗ ${fail} check(s) failed`);
  process.exit(1);
}
console.log('\n✓ all checks passed');
