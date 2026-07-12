import { expect, test } from '@playwright/test'
import { ACCESS_HASHES, ACCESS_STORAGE_KEY } from '../../src/lib/access'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ key, hash }) => localStorage.setItem(key, hash), { key: ACCESS_STORAGE_KEY, hash: ACCESS_HASHES[0] })
  await page.goto('/')
  const tomorrow = page.locator('.date-chip').filter({ hasText: 'завтра' })
  await tomorrow.click()
  await expect(page.locator('.trip-card').first()).toBeVisible()
})

test('shows the saved access grant and allows logout', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Выйти' })).toBeVisible()
  await page.getByRole('button', { name: 'Выйти' }).click()
  await expect(page.getByRole('heading', { name: 'Вход на сайт' })).toBeVisible()
  await expect(page.evaluate((key) => localStorage.getItem(key), ACCESS_STORAGE_KEY)).resolves.toBeNull()
})

test('changes direction, sorts and opens a booking link', async ({ page }) => {
  await expect(page.getByRole('heading', { name: /Из Могилёва/ })).toBeVisible()
  await page.getByRole('button', { name: 'Поменять города местами' }).click()
  await expect(page.getByText('Минск → Могилёв')).toBeVisible()
  await page.locator('.date-chip').filter({ hasText: 'завтра' }).click()
  await page.locator('.results-actions select').selectOption('price')
  const link = page.locator('.booking-button').first()
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('href', /^https:\/\//)
})

test('filters and shows source transparency', async ({ page, isMobile }) => {
  if (isMobile) {
    await page.getByRole('button', { name: 'Фильтры' }).click()
    await expect(page.locator('.mobile-sheet')).toBeVisible()
    await page.locator('.mobile-sheet').getByRole('button', { name: 'Поезда' }).click()
    await page.getByRole('button', { name: 'Показать рейсы' }).click()
  } else {
    await expect(page.locator('.results-layout > .filters')).toBeVisible()
    await page.locator('.results-layout > .filters').getByRole('button', { name: 'Поезда' }).click()
  }
  await expect(page.locator('.trip-card')).toHaveCount(1)
  await expect(page.locator('.trip-card')).toContainText('Белорусская железная дорога')
  if (isMobile) await page.getByRole('button', { name: 'Все источники →' }).click()
  else await page.getByRole('button', { name: 'Источники', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Источники данных' })).toBeVisible()
  await expect(page.locator('.source-item')).toHaveCount(6)
})
