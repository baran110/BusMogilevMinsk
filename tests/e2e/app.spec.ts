import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  const tomorrow = page.locator('.date-chip').filter({ hasText: 'завтра' })
  await tomorrow.click()
  await expect(page.locator('.trip-card').first()).toBeVisible()
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
