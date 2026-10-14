import { expect, test } from '@playwright/test'
import { TEST_KEY } from '../fixtures/schedule'

async function login(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.getByLabel('Ключ доступа').fill(TEST_KEY)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Выйти' })).toBeVisible()
  await page.locator('.date-chip').filter({ hasText: 'завтра' }).click()
  await expect(page.locator('.trip-card')).toHaveCount(3)
}

test('rejects a browser-only grant and persists a server session across reloads', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mm-access-grant-v1', 'old-public-grant'))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Вход на сайт' })).toBeVisible()
  expect((await page.request.get('/api/trips?direction=mogilev-minsk&date=2026-10-15')).status()).toBe(401)
  await login(page)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Выйти' })).toBeVisible()
  await page.getByRole('button', { name: 'Выйти' }).click()
  await expect(page.getByRole('heading', { name: 'Вход на сайт' })).toBeVisible()
  expect((await page.request.get('/api/trips?direction=mogilev-minsk&date=2026-10-15')).status()).toBe(401)
})

test('changes direction, sorts known prices and retains unknown availability', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: 'Поменять города местами' }).click()
  await expect(page.getByText('Минск → Могилёв')).toBeVisible()
  await page.locator('.results-actions select').selectOption('price')
  await expect(page.locator('.trip-card').last()).toContainText('Наличие мест неизвестно')
  await expect(page.locator('.trip-card').last()).toContainText('Уточнить')
  await expect(page.locator('.booking-button').first()).toHaveAttribute('href', 'https://avto-slava.by/')
})

test('filters trains on mobile and desktop and shows actual fixture sources', async ({ page, isMobile }) => {
  await login(page)
  if (isMobile) {
    await page.getByRole('button', { name: 'Фильтры' }).click()
    await page.locator('.mobile-sheet').getByRole('button', { name: 'Поезда' }).click()
    await page.getByRole('button', { name: 'Показать рейсы' }).click()
  } else await page.locator('.results-layout > .filters').getByRole('button', { name: 'Поезда' }).click()
  await expect(page.locator('.trip-card')).toHaveCount(1)
  await expect(page.locator('.trip-card')).toContainText('Тестовый поезд')
  await page.getByRole('button', { name: 'Все источники →' }).click()
  await expect(page.getByRole('dialog', { name: 'Источники данных' })).toBeVisible()
  await expect(page.locator('.source-item')).toHaveCount(1)
})

test('API errors produce a retry state without fictional trips', async ({ page }) => {
  await login(page)
  await page.route('**/api/trips?**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }))
  await page.getByRole('button', { name: 'Поменять города местами' }).click()
  await expect(page.getByRole('heading', { name: 'Не удалось получить расписание' })).toBeVisible()
  await expect(page.locator('.trip-card')).toHaveCount(0)
  await expect(page.getByText('Демонстрационный режим')).toHaveCount(0)
  await page.unroute('**/api/trips?**')
  await page.getByRole('button', { name: 'Повторить поиск' }).click()
  await expect(page.locator('.trip-card')).toHaveCount(3)
})

test('expired session returns to the key form', async ({ page }) => {
  await login(page)
  await page.context().clearCookies()
  await page.getByRole('button', { name: 'Поменять города местами' }).click()
  await expect(page.getByRole('heading', { name: 'Вход на сайт' })).toBeVisible()
  await expect(page.locator('.trip-card')).toHaveCount(0)
})
