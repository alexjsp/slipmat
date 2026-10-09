/**
 * Turn raw UI captures into the framed images the README shows.
 *
 * Each image is a small HTML page — phones or a browser window on a gradient —
 * rendered by the same headless Chromium that took the captures, so there is
 * no image tooling to install. Run after scripts/screenshots.ts.
 *
 *   pnpm --filter @slipmat/web exec tsx scripts/frame-screenshots.ts <shotsDir> <outDir>
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const shotsDir = process.argv[2] ?? './screenshots'
const outDir = process.argv[3] ?? '../../docs/images'

const WIDTH = 1200

const dataUri = (name: string) =>
  `data:image/png;base64,${readFileSync(join(shotsDir, name)).toString('base64')}`

/** Signal, wifi and battery, drawn rather than shipped. */
const STATUS_ICONS = `<svg width="66" height="14" viewBox="0 0 66 14" fill="currentColor">
  <rect x="0" y="9" width="3" height="5" rx="1"/><rect x="5" y="6" width="3" height="8" rx="1"/>
  <rect x="10" y="3" width="3" height="11" rx="1"/><rect x="15" y="0" width="3" height="14" rx="1"/>
  <path d="M30 13.5l-2.6-2.6a3.7 3.7 0 0 1 5.2 0zM25.6 9.1a6.2 6.2 0 0 1 8.8 0l1.3-1.3a8 8 0 0 0-11.4 0zM22.9 6.4a10 10 0 0 1 14.2 0l1.3-1.3a11.9 11.9 0 0 0-16.8 0z"/>
  <rect x="42.5" y="1.5" width="20" height="11" rx="3" fill="none" stroke="currentColor" opacity="0.5"/>
  <rect x="44.5" y="3.5" width="14" height="7" rx="1.5"/><rect x="63.5" y="5" width="1.5" height="4" rx="0.75" opacity="0.5"/>
</svg>`

const phone = (name: string, caption: string) => `
  <figure>
    <div class="phone">
      <div class="screen">
        <div class="status"><span>9:41</span><b></b>${STATUS_ICONS}</div>
        <img src="${dataUri(name)}" alt="">
      </div>
    </div>
    <figcaption>${caption}</figcaption>
  </figure>`

const browserWindow = (name: string) => `
  <div class="window">
    <div class="bar"><i></i><i></i><i></i><span>slipmat.local:5544</span></div>
    <img src="${dataUri(name)}" alt="">
  </div>`

const page = (body: string) => `<!doctype html>
<html><head><style>
  * { box-sizing: border-box; margin: 0; }
  /* Its own background, so the body's gradient paints the body box only rather
     than tiling down the canvas past it. */
  html { background: #0b0b0f; }
  body {
    width: ${WIDTH}px;
    padding: 64px 56px 56px;
    font: 500 20px/1.3 -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
    color: #f4f4f5;
    /* The logo's record: warm orange into deep red, over near-black. */
    background:
      radial-gradient(ellipse 80% 60% at 15% 0%, rgba(249, 115, 22, 0.45), transparent 70%),
      radial-gradient(ellipse 70% 60% at 100% 100%, rgba(220, 38, 38, 0.4), transparent 70%),
      #0b0b0f;
  }
  .row { display: flex; justify-content: center; gap: 48px; align-items: flex-start; }
  figure { display: flex; flex-direction: column; align-items: center; gap: 22px; }
  figcaption { color: #d4d4d8; letter-spacing: 0.01em; }
  .phone {
    width: 320px;
    padding: 12px;
    border-radius: 52px;
    background: #1c1c21;
    box-shadow:
      0 0 0 2px #2e2e35,
      0 30px 60px -12px rgba(0, 0, 0, 0.7),
      0 18px 36px -18px rgba(0, 0, 0, 0.6);
  }
  /* The app's own background, so the status bar reads as part of the screen. */
  .screen {
    overflow: hidden;
    border-radius: 40px;
    padding-bottom: 18px;
    background: oklch(0.141 0.005 285.823);
  }
  /* Room for the corner curve, so it never clips the app's first row. */
  .status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 46px;
    padding: 4px 26px 0 34px;
    font-size: 15px;
    font-weight: 600;
  }
  .status b { width: 92px; height: 27px; border-radius: 14px; background: #000; }
  .phone img { display: block; width: 100%; }
  .window {
    border-radius: 14px;
    overflow: hidden;
    background: #1c1c21;
    box-shadow: 0 0 0 1px #2e2e35, 0 40px 80px -20px rgba(0, 0, 0, 0.75);
  }
  .bar { display: flex; align-items: center; gap: 8px; padding: 14px 16px; background: #232329; }
  .bar i { width: 12px; height: 12px; border-radius: 50%; background: #3f3f46; }
  .bar i:nth-child(1) { background: #ff5f57; }
  .bar i:nth-child(2) { background: #febc2e; }
  .bar i:nth-child(3) { background: #28c840; }
  .bar span {
    margin: 0 auto;
    padding: 4px 80px;
    border-radius: 6px;
    background: #2e2e35;
    color: #a1a1aa;
    font-size: 14px;
    transform: translateX(-28px);
  }
  .window img { display: block; width: 100%; }
</style></head><body>${body}</body></html>`

const IMAGES: { name: string; html: string }[] = [
  { name: 'desktop.png', html: page(browserWindow('12-desktop-now-playing.png')) },
  {
    name: 'playback.png',
    html: page(`<div class="row">
      ${phone('01-now-playing.png', 'Every room at a glance')}
      ${phone('03-group-sheet.png', 'Group rooms and set volumes')}
    </div>`),
  },
  {
    name: 'presets.png',
    html: page(`<div class="row">
      ${phone('04-presets.png', 'One tap to start a preset')}
      ${phone('05-preset-editor.png', 'Speakers, volumes, sources')}
      ${phone('07-rule-editor.png', 'Rules by day, month or time')}
    </div>`),
  },
  {
    name: 'sources.png',
    html: page(`<div class="row">
      ${phone('09-source-picker-link.png', 'Paste a Spotify or Apple Music link')}
      ${phone('11-settings.png', 'HomeKit, webhooks and blocked music')}
    </div>`),
  },
]

async function main() {
  mkdirSync(outDir, { recursive: true })
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: 800 },
    deviceScaleFactor: 1.5,
  })
  const tab = await context.newPage()
  for (const image of IMAGES) {
    await tab.setContent(image.html, { waitUntil: 'load' })
    // The body, not the page: the page can run a few pixels past it.
    await tab.locator('body').screenshot({ path: join(outDir, image.name) })
    console.log(`  ${image.name}`)
  }
  await browser.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
