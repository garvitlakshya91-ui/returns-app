// Pull a few frames out of a recorded .webm (no ffmpeg on this machine):
// plays it fast in headless Chromium and screenshots the <video> as it passes
// each requested second. Playwright's WebMs have no duration index, so
// seeking is unreliable; playing through is not.
// Usage: node scripts/video-frames.mjs <file.webm> <outDir> <sec> [<sec>...]
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [file, outDir, ...secs] = process.argv.slice(2);
const targets = secs.map(Number).sort((a, b) => a - b);
mkdirSync(outDir, { recursive: true });
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1600, height: 900 } });
// A blank page may not load file:// media; a page that is itself a file may.
const html = resolve(outDir, '_player.html');
writeFileSync(html, `<body style="margin:0;background:#000"><video id="v" width="1600" height="900" muted playsinline src="${pathToFileURL(resolve(file)).href}"></video></body>`);
await pg.goto(pathToFileURL(html).href);
await pg.evaluate(() => { const v = document.getElementById('v'); v.playbackRate = 8; return v.play(); });

for (const t of targets) {
  await pg.waitForFunction((target) => {
    const v = document.getElementById('v');
    return v.currentTime >= target || v.ended;
  }, t, { timeout: 600000, polling: 50 });
  await pg.evaluate(() => document.getElementById('v').pause());
  const now = await pg.evaluate(() => document.getElementById('v').currentTime);
  await pg.locator('#v').screenshot({ path: resolve(outDir, `f${t}.png`) });
  console.log('frame', t, 'at', now.toFixed(1));
  await pg.evaluate(() => document.getElementById('v').play());
}
const dur = await pg.evaluate(() => document.getElementById('v').currentTime);
console.log('last position', dur.toFixed(1));
await b.close();
