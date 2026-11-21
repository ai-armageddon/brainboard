// Render the social share card scripts/og.html to public/og.png (1200×630) with headless Chrome: node scripts/og.ts
// Set CHROME to the browser binary if it isn't in the default macOS location.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const root = path.resolve(import.meta.dirname, '..');
const profile = mkdtempSync(path.join(tmpdir(), 'brainboard-og-'));
const out = path.join(root, 'public/og.png');

try {
  execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    `--user-data-dir=${profile}`,
    '--window-size=1200,630', '--force-device-scale-factor=1',
    '--virtual-time-budget=3000', // let the web fonts load before the shot
    `--screenshot=${out}`,
    pathToFileURL(path.join(root, 'scripts/og.html')).href,
  ], { stdio: 'ignore' });
  console.log(`wrote ${path.relative(root, out)}`);
} finally {
  rmSync(profile, { recursive: true, force: true });
}
