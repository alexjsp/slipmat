/**
 * The preset sheet's dismissal and save behaviour, against the fake household.
 *
 * Two things worth guarding, both of which lose work when they regress: a stray
 * tap on the overlay must not discard a half-built preset, and rules must be
 * saved by the form's own Save — they used to have a button of their own, and
 * only appeared once the preset already existed.
 *
 *   pnpm --filter @slipmat/web exec tsx scripts/check-preset-dialog.ts [baseUrl]
 */
import { chromium } from 'playwright'

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:5599'
const failures: string[] = []
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  if (!ok) failures.push(name)
}

const browser = await chromium.launch()
const page = await browser.newPage()
await page.setViewportSize({ width: 430, height: 860 })
await page.goto(baseUrl, { waitUntil: 'networkidle' })
await page.getByRole('link', { name: 'Presets' }).click()
await page.getByRole('button', { name: /New preset/ }).click()
await page.waitForTimeout(400)

// The page behind has a "New preset" button too, so match the dialog itself.
const sheet = page.getByRole('dialog')
check('sheet opens', await sheet.isVisible())
check('rules are offered before the preset exists', await sheet.getByText('Rules').isVisible())

await page.mouse.click(215, 20)
await page.waitForTimeout(600)
check('an outside click does not dismiss it', await sheet.isVisible())

check(
  'rules have no save button of their own',
  !(await page
    .getByRole('button', { name: 'Save rules' })
    .isVisible()
    .catch(() => false)),
)

await page.keyboard.press('Escape')
await page.waitForTimeout(800)
check('Escape still dismisses it', !(await sheet.isVisible()))

await browser.close()
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
