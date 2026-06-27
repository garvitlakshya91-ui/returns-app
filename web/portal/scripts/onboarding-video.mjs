// Renders a polished, self-contained ReturnFlow onboarding video (1600x900).
// Each scene is a branded HTML page with CSS entrance animations; Playwright
// records the sequence. No dev servers or API mocks needed — every frame is
// on-brand and deterministic.
//
// Usage: node web/portal/scripts/onboarding-video.mjs
import { chromium } from 'playwright';
import { mkdirSync, renameSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../../../brand/screenshots/video');
mkdirSync(OUT, { recursive: true });

const VIEWPORT = { width: 1600, height: 900 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INDIGO = '#4F46E5';
const PKG = '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/>';

const FONTS = `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Poppins:wght@600;700;800&display=swap');`;
const BASE = `
  ${FONTS}
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{height:100%;font-family:'Inter',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
  .stage{height:100vh;width:100vw;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;overflow:hidden;position:relative}
  h1{font-family:'Poppins';font-weight:800;letter-spacing:-1.5px;line-height:1.05}
  .kicker{text-transform:uppercase;letter-spacing:3px;font-size:14px;font-weight:600;opacity:.7;margin-bottom:18px}
  .sub{font-size:24px;opacity:.85;margin-top:18px;max-width:920px;font-weight:400;line-height:1.4}
  .logo{width:96px;height:96px;border-radius:24px;display:flex;align-items:center;justify-content:center;box-shadow:0 12px 40px rgba(79,70,229,.35)}
  @keyframes up{from{opacity:0;transform:translateY(26px)}to{opacity:1;transform:translateY(0)}}
  @keyframes pop{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:scale(1)}}
  @keyframes fade{from{opacity:0}to{opacity:1}}
  .a1{animation:up .7s both}.a2{animation:up .7s .15s both}.a3{animation:up .7s .3s both}.a4{animation:up .7s .45s both}
  .pop{animation:pop .6s both}
  .card{background:#fff;border:1px solid #ECECF1;border-radius:16px;box-shadow:0 18px 50px rgba(20,20,40,.12);text-align:left}
  .badge{display:inline-block;font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px}
`;

const logoTile = (bg = 'rgba(255,255,255,.16)', stroke = '#fff') =>
  `<div class="logo" style="background:${bg}"><svg width="50" height="50" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${PKG}</svg></div>`;

// ── Scenes ──────────────────────────────────────────────────────────────────
const scenes = [
  // 1 — Hook
  { hold: 4200, html: `<div class="stage" style="background:#0F1020;color:#fff">
      <div class="kicker a1" style="color:#A5A1F5">Returns, sorted</div>
      <h1 class="a2" style="font-size:64px">Returns shouldn't<br/>eat your day.</h1>
      <p class="sub a3" style="opacity:.7">Endless emails. Printer labels. Refund chaos.</p>
    </div>` },

  // 2 — Brand reveal
  { hold: 3600, html: `<div class="stage" style="background:radial-gradient(1200px 700px at 50% 10%, #6366F1 0%, #4338CA 70%);color:#fff">
      <div class="pop" style="margin-bottom:26px">${logoTile()}</div>
      <h1 class="a2" style="font-size:60px">ReturnFlow</h1>
      <p class="sub a3">Self-serve returns, carrier labels & exchanges<br/>for UK Shopify stores.</p>
    </div>` },

  // 3 — Customer portal (phone mockup)
  { hold: 5200, html: `<div class="stage" style="background:#F6F6FB;color:#16162A">
      <div style="display:flex;align-items:center;gap:60px">
        <div style="text-align:left;max-width:520px">
          <div class="kicker a1" style="color:${INDIGO}">For your customers</div>
          <h1 class="a2" style="font-size:46px;color:#16162A">A return in<br/>under a minute</h1>
          <p class="a3" style="font-size:21px;color:#55556B;margin-top:18px;line-height:1.5">On a branded portal: look up the order, pick items, choose refund, store credit or exchange — and get a label.</p>
        </div>
        <div class="pop" style="width:300px;height:600px;background:#111;border-radius:42px;padding:14px;box-shadow:0 30px 70px rgba(20,20,40,.25)">
          <div style="background:#fff;height:100%;border-radius:30px;padding:26px 22px;overflow:hidden">
            <div style="font-family:'Poppins';font-weight:700;font-size:20px;color:${INDIGO}">Wildgrove & Co.</div>
            <div style="font-weight:700;font-size:24px;margin-top:18px;color:#16162A">Start a return</div>
            <div style="margin-top:18px;border:1px solid #ECECF1;border-radius:12px;padding:14px;display:flex;gap:12px;align-items:center">
              <div style="width:46px;height:46px;border-radius:8px;background:#EEF0FF"></div>
              <div><div style="font-weight:600;font-size:14px">Merino Wool Jumper</div><div style="font-size:12px;color:#8A8AA0">Medium / Forest · £68</div></div>
            </div>
            <div style="margin-top:16px;font-size:13px;color:#8A8AA0;font-weight:600">CHOOSE RESOLUTION</div>
            <div style="margin-top:10px;background:${INDIGO};color:#fff;border-radius:10px;padding:12px;text-align:center;font-weight:600;font-size:14px">Refund to card</div>
            <div style="margin-top:8px;border:1px solid #ECECF1;border-radius:10px;padding:12px;text-align:center;font-weight:600;font-size:14px;color:#55556B">Store credit</div>
            <div style="margin-top:8px;border:1px solid #ECECF1;border-radius:10px;padding:12px;text-align:center;font-weight:600;font-size:14px;color:#55556B">Exchange</div>
          </div>
        </div>
      </div>
    </div>` },

  // 4a — Managed labels (the hero) — the toggle
  { hold: 4200, html: `<div class="stage" style="background:#0F1020;color:#fff">
      <div class="kicker a1" style="color:#A5A1F5">The magic part</div>
      <h1 class="a2" style="font-size:52px">One click. Every carrier.</h1>
      <div class="card a3" style="margin-top:34px;width:760px;padding:26px 28px;background:#fff;color:#16162A;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="display:flex;gap:10px;align-items:center">
            <div style="font-family:'Poppins';font-weight:700;font-size:20px">Managed return labels</div>
            <span class="badge" style="background:#E7F9ED;color:#0B8A43">Recommended</span>
          </div>
          <div style="font-size:15px;color:#55556B;margin-top:8px;max-width:480px">Generate real Royal Mail & Evri labels automatically — no carrier account, no API keys.</div>
        </div>
        <div style="background:${INDIGO};color:#fff;padding:12px 26px;border-radius:10px;font-weight:600">Enable</div>
      </div>
    </div>` },

  // 4b — Managed labels — enabled state + payoff line
  { hold: 4400, html: `<div class="stage" style="background:radial-gradient(1200px 700px at 50% 0%, #5B53E8 0%, #2E2796 75%);color:#fff">
      <div class="card pop" style="width:760px;padding:26px 28px;background:#fff;color:#16162A;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="display:flex;gap:10px;align-items:center">
            <div style="font-family:'Poppins';font-weight:700;font-size:20px">Managed return labels</div>
            <span class="badge" style="background:#E7F9ED;color:#0B8A43">On</span>
          </div>
          <div style="font-size:15px;color:#55556B;margin-top:8px;max-width:480px">Real labels, billed per-label on your Shopify invoice. Postage + a small fee.</div>
        </div>
        <div style="border:1px solid #ECECF1;color:#55556B;padding:12px 22px;border-radius:10px;font-weight:600">Turn off</div>
      </div>
      <p class="sub a3" style="margin-top:30px;font-weight:500">No couriers to chase. No accounts to set up.<br/>Just one button.</p>
    </div>` },

  // 5 — Manage & insight (montage)
  { hold: 5200, html: `<div class="stage" style="background:#F6F6FB;color:#16162A">
      <div class="kicker a1" style="color:${INDIGO}">For you, the merchant</div>
      <h1 class="a2" style="font-size:46px">Manage everything in Shopify</h1>
      <div style="display:flex;gap:22px;margin-top:34px">
        <div class="card a2" style="width:300px;height:200px;padding:20px">
          <div style="font-weight:700;font-size:15px;margin-bottom:14px">Returns</div>
          ${[0,1,2].map((i)=>`<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px"><div style="width:16px;height:16px;border:2px solid ${i===0?INDIGO:'#D7D7E3'};border-radius:4px;background:${i===0?INDIGO:'#fff'}"></div><div style="font-size:13px;color:#55556B">#10${42-i} · £${68-i*8}.00</div></div>`).join('')}
          <div style="margin-top:8px;display:inline-block;background:${INDIGO};color:#fff;font-size:12px;font-weight:600;padding:6px 12px;border-radius:8px">Approve · Reject</div>
        </div>
        <div class="card a3" style="width:300px;height:200px;padding:20px">
          <div style="font-weight:700;font-size:15px;margin-bottom:14px">Analytics</div>
          <svg width="260" height="120" viewBox="0 0 260 120"><polyline points="0,90 40,70 80,80 120,40 160,55 200,25 240,35" fill="none" stroke="${INDIGO}" stroke-width="3"/><polyline points="0,100 40,95 80,98 120,80 160,88 200,70 240,78" fill="none" stroke="#34C759" stroke-width="3"/></svg>
        </div>
        <div class="card a4" style="width:300px;height:200px;padding:20px">
          <div style="font-weight:700;font-size:15px;margin-bottom:14px">Policy rules</div>
          <div style="font-size:13px;color:#55556B;line-height:1.7"><b>Final sale</b> → not returnable<br/><b>Over £100</b> → refund only<br/><b>Changed mind</b> → £3 fee</div>
        </div>
      </div>
      <p class="a4" style="font-size:19px;color:#55556B;margin-top:26px">Bulk approvals · return insights · smart rules</p>
    </div>` },

  // 6 — Plans
  { hold: 5600, html: `<div class="stage" style="background:#0F1020;color:#fff">
      <h1 class="a1" style="font-size:46px;margin-bottom:8px">Start free. Grow when you do.</h1>
      <div style="display:flex;gap:22px;margin-top:30px;align-items:stretch">
        ${[
          {n:'Free',p:'£0',f:['30 returns/mo','Branded portal','Refund + credit'],hl:false},
          {n:'Starter',p:'£9',f:['150 returns/mo','Managed labels','Exchanges + CSV'],hl:true},
          {n:'Growth',p:'£29',f:['Unlimited returns','Full analytics','Policy rule builder'],hl:false},
        ].map((t,i)=>`<div class="card ${['a2','a3','a4'][i]}" style="width:280px;padding:26px 24px;background:${t.hl?INDIGO:'#fff'};color:${t.hl?'#fff':'#16162A'};${t.hl?'transform:translateY(-12px);box-shadow:0 24px 60px rgba(79,70,229,.5)':''}">
            ${t.hl?'<div class="badge" style="background:rgba(255,255,255,.2);color:#fff;margin-bottom:10px">Most popular</div>':''}
            <div style="font-family:'Poppins';font-weight:700;font-size:22px">${t.n}</div>
            <div style="font-size:38px;font-weight:800;font-family:'Poppins';margin:6px 0 16px">${t.p}<span style="font-size:15px;font-weight:500;opacity:.7">/mo</span></div>
            ${t.f.map((x)=>`<div style="font-size:14px;margin-bottom:10px;opacity:${t.hl?1:.8}">✓ ${x}</div>`).join('')}
          </div>`).join('')}
      </div>
      <p class="sub a4" style="margin-top:28px;font-size:18px">14-day free trial on paid plans · annual = 2 months free</p>
    </div>` },

  // 7 — CTA
  { hold: 4400, html: `<div class="stage" style="background:radial-gradient(1200px 700px at 50% 0%, #6366F1 0%, #4338CA 70%);color:#fff">
      <div class="pop" style="margin-bottom:26px">${logoTile()}</div>
      <h1 class="a2" style="font-size:54px">Returns, finally effortless.</h1>
      <div class="a3" style="margin-top:28px;background:#fff;color:${INDIGO};font-weight:700;padding:16px 34px;border-radius:12px;font-size:19px">Add ReturnFlow — free 14-day trial</div>
      <p class="sub a4" style="margin-top:24px;font-size:18px;opacity:.85">app.returnsflow.uk</p>
    </div>` },
];

// ── Record ──────────────────────────────────────────────────────────────────
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: VIEWPORT, recordVideo: { dir: OUT, size: VIEWPORT } });
const page = await context.newPage();

for (const s of scenes) {
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${BASE}</style></head><body>${s.html}</body></html>`, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await sleep(s.hold);
}

await context.close();
await browser.close();

const f = readdirSync(OUT).filter((x) => x.endsWith('.webm') && x.startsWith('page'));
if (f.length) {
  renameSync(resolve(OUT, f[0]), resolve(OUT, 'onboarding.webm'));
  console.log('Saved brand/screenshots/video/onboarding.webm');
}
