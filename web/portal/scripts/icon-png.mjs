// Render brand/app-icon.svg to an exact 1200x1200 PNG using Chromium.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SVG = resolve(__dirname, '../../../brand/app-icon.svg');
const OUT = resolve(__dirname, '../../../brand/app-icon-1200.png');

const svg = readFileSync(SVG, 'utf8');
const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0}svg{display:block;width:1200px;height:1200px}</style>
${svg}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 1200 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'networkidle' });
await page.screenshot({ path: OUT, clip: { x: 0, y: 0, width: 1200, height: 1200 } });
await browser.close();
console.log('Wrote', OUT);
