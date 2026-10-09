/**
 * Capture the whole UI against the fake household.
 *
 * Interactive surfaces (the preset editor, the source picker, the rule editor)
 * only exist behind a click, so the plain headless-shell `--screenshot` flag
 * can't reach them. Assumes a Slipmat server is already running with
 * SLIPMAT_FAKE_SONOS=1.
 *
 *   pnpm --filter @slipmat/web exec tsx scripts/screenshots.ts <outDir> [baseUrl]
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const outDir = process.argv[2] ?? './screenshots'
const baseUrl = process.argv[3] ?? 'http://127.0.0.1:5599'

const PHONE = { width: 430, height: 860 }
const DESKTOP = { width: 1100, height: 800 }

async function main() {
  mkdirSync(outDir, { recursive: true })
  const browser = await chromium.launch()

  const shot = async (
    name: string,
    viewport: { width: number; height: number },
    steps: (page: import('playwright').Page) => Promise<void>,
  ) => {
    const context = await browser.newContext({
      viewport,
      colorScheme: 'dark',
      deviceScaleFactor: 2,
    })
    const page = await context.newPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await steps(page)
    await page.screenshot({ path: join(outDir, name) })
    await context.close()
    console.log(`  ${name}`)
  }

  await shot('01-now-playing.png', PHONE, async () => {})

  await shot('02-now-playing-expanded.png', PHONE, async (page) => {
    await page.getByText(/idle room/).click()
    await page.waitForTimeout(300)
  })

  await shot('03-group-sheet.png', PHONE, async (page) => {
    await page.getByRole('button', { name: /adjust volumes/ }).click()
    await page.waitForTimeout(500)
  })

  await shot('04-presets.png', PHONE, async (page) => {
    await page.getByRole('link', { name: 'Presets' }).click()
    await page.waitForTimeout(400)
  })

  await shot('05-preset-editor.png', PHONE, async (page) => {
    await page.getByRole('link', { name: 'Presets' }).click()
    await page.getByRole('button', { name: 'Edit preset' }).first().click()
    await page.waitForTimeout(600)
  })

  await shot('06-preset-editor-behaviour.png', PHONE, async (page) => {
    await page.getByRole('link', { name: 'Presets' }).click()
    await page.getByRole('button', { name: 'Edit preset' }).first().click()
    await page.waitForTimeout(600)
    await page.getByText('Behaviour').scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
  })

  await shot('07-rule-editor.png', PHONE, async (page) => {
    await page.getByRole('link', { name: 'Presets' }).click()
    await page.getByRole('button', { name: 'Edit preset' }).first().click()
    await page.waitForTimeout(800)
    await page.getByText('Right now this would play').scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
  })

  await shot('08-source-picker-browse.png', PHONE, async (page) => {
    await page.getByRole('link', { name: 'Presets' }).click()
    await page.getByRole('button', { name: 'Edit preset' }).first().click()
    await page.waitForTimeout(600)
    await page.getByRole('button', { name: 'Add', exact: true }).first().click()
    await page.waitForTimeout(600)
  })

  await shot('09-source-picker-link.png', PHONE, async (page) => {
    await page.getByRole('link', { name: 'Presets' }).click()
    await page.getByRole('button', { name: 'Edit preset' }).first().click()
    await page.waitForTimeout(600)
    await page.getByRole('button', { name: 'Add', exact: true }).first().click()
    await page.waitForTimeout(400)
    await page.getByRole('tab', { name: 'Paste a link' }).click()
    await page.waitForTimeout(400)
  })

  await shot('10-new-preset.png', PHONE, async (page) => {
    await page.getByRole('link', { name: 'Presets' }).click()
    await page.getByRole('button', { name: 'New' }).click()
    await page.waitForTimeout(600)
  })

  await shot('11-settings.png', PHONE, async (page) => {
    await page.getByRole('link', { name: 'Settings' }).click()
    await page.waitForTimeout(500)
  })

  await shot('12-desktop-now-playing.png', DESKTOP, async () => {})

  await shot('13-desktop-presets.png', DESKTOP, async (page) => {
    await page.getByRole('link', { name: 'Presets' }).click()
    await page.waitForTimeout(400)
  })

  // Light mode: the app styles both, so it's worth proving.
  const light = await browser.newContext({
    viewport: PHONE,
    colorScheme: 'light',
    deviceScaleFactor: 2,
  })
  const lightPage = await light.newPage()
  await lightPage.goto(baseUrl, { waitUntil: 'networkidle' })
  await lightPage.evaluate(() => document.documentElement.classList.remove('dark'))
  await lightPage.waitForTimeout(300)
  await lightPage.screenshot({ path: join(outDir, '14-light-mode.png') })
  console.log('  14-light-mode.png')
  await light.close()

  await browser.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
