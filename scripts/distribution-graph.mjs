// Exact-data histogram; local output only, no chain transactions.
import assert from 'node:assert/strict';
import {readFile, writeFile, access} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';

const input = process.argv[2];
const output = process.argv[3];
assert(input && output, 'Usage: node scripts/distribution-graph.mjs input.json output.svg [--wait]');
if (process.argv.includes('--wait')) {
  const deadline = Date.now() + 60 * 60 * 1000;
  for (;;) {
    try {
      await access(input);
      const ready = JSON.parse(await readFile(input, 'utf8'));
      if (ready.samples?.length === ready.count) break;
    } catch { /* Result writer may not have finished yet. */ }
    assert(Date.now() < deadline, 'Timed out waiting for completed distribution results');
    await sleep(1000);
  }
}
const data = JSON.parse(await readFile(input, 'utf8'));
assert.equal(data.samples.length, data.count);
const bins = Array(10).fill(0);
for (const sample of data.samples) {
  const roll = BigInt(sample.roll);
  assert(roll >= 1n && roll <= 1000000n);
  bins[Number((roll - 1n) / 100000n)]++;
}
const expected = data.count / 10;
const ceiling = Math.ceil(Math.max(expected, ...bins) * 1.2 / 100) * 100;
const x = i => 80 + i * 82;
const y = count => 340 - count / ceiling * 250;
const text = (x, y, value, anchor = 'middle') => `<text x="${x}" y="${y}" text-anchor="${anchor}">${value}</text>`;
const bars = bins.map((count, i) => `<rect x="${x(i) + 3}" y="${y(count)}" width="76" height="${340 - y(count)}" fill="#315e9c"/>${text(x(i) + 41, y(count) - 8, count)}`).join('');
const ticks = [0, 2, 4, 6, 8, 10].map(i => text(x(i), 367, i === 0 ? '1' : `${i * 100}k`)).join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="430" viewBox="0 0 960 430" role="img" aria-label="Histogram of ${data.count} local OpenVRF mapped rolls">
<rect width="960" height="430" fill="white"/><style>text{font-family:Arial,sans-serif;font-size:14px;fill:#20241f}</style>
${text(480, 30, `OpenVRF — ${data.count.toLocaleString('en-US')} local rolls`)}
${text(480, 55, `Range 1–1,000,000 · Uniform expectation ${expected} per bin`)}
<path d="M80 90V340H900" fill="none" stroke="#606760"/>
${bars}<path d="M80 ${y(expected)}H900" stroke="#20241f" stroke-dasharray="6 4"/>
${[0, expected, ceiling].map(n => text(70, y(n) + 5, n, 'end')).join('')}${ticks}
${text(480, 398, 'Mapped roll')}
<text x="20" y="220" text-anchor="middle" transform="rotate(-90 20 220)">Roll count</text>
${text(480, 422, 'Local contract requests · Fixed verified public beacon round · Dashed line: uniform expectation')}
</svg>`;
await writeFile(output, svg);
console.log(JSON.stringify({input, output, samples: data.count, bins, expected}, null, 2));
