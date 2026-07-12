import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { localDate } from '../src/lib/date'
import { isSnapshotExpired, mergeExactTrips } from '../src/lib/trips'
import type { Direction, DirectionSnapshot, SnapshotManifest, SourceHealth, Trip } from '../src/types'
import { readPrevious, publishSnapshots } from './lib/kv'
import type { SourceResult } from './lib/source'
import { checkSource } from './sources/availability'
import { collectAtlas } from './sources/atlas'
import { collectBusPro } from './sources/buspro'
import { collectBzd } from './sources/bzd'
import { collectTransporter } from './sources/transporter'

const localOnly = process.argv.includes('--local')
const generatedAt = new Date().toISOString()

const directResults = await Promise.all([
  collectTransporter({ id: 'avtoslava', name: 'АвтоСлава', baseUrl: 'https://avto-slava.by', bookingUrl: 'https://avto-slava.by/', kind: 'carrier' }),
  collectTransporter({ id: 'minsk-express', name: 'Минск Экспресс', baseUrl: 'https://mogilevminsk.by', bookingUrl: 'https://mogilevminsk.by/', kind: 'carrier' }),
  collectTransporter({ id: 'vitexpress', name: 'ВитЭкспресс', baseUrl: 'https://vitexpress.driveprof.com', bookingUrl: 'https://vitexpress.by/online-bron', kind: 'carrier', cityIds: { mogilev: 15, minsk: 18 } }),
  collectBusPro({ id: 'grandexpress', name: 'ГрандЭкспресс', companyId: 8, bookingUrl: 'https://grandexpress.by/' }),
  collectBusPro({ id: 'new-line', name: 'Новая Линия', companyId: 51, bookingUrl: 'https://7777040.by/' }),
  collectBzd(),
  checkSource('smilebus', 'Смайлбус', 'carrier', 'https://smilebus.by/', 'Открытый API доступен, но маршрут Могилёв—Минск сейчас не опубликован'),
  checkSource('busnavi', 'БусНави', 'carrier', 'https://busnavi.by/', 'Сайт работает через BusPro company 11; в открытом API опубликованы только маршруты Могилёв—Кличев и Могилёв—Дрибин'),
  checkSource('vitexpress-ru', 'Vitexpress.ru / СтритТорг', 'carrier', 'https://vitexpress.ru/', 'Отдельный перевозчик международных рейсов; подтверждённый самостоятельный рейс на участке Могилёв—Минск не найден'),
  checkSource('ap1-mogilev', 'Автобусный парк №1 Могилёва', 'carrier', 'https://ap1mogilev.by/', 'Официальный сайт филиала; электронная продажа междугородних билетов ведёт на TicketBus'),
  checkSource('mogobltrans', 'Могилевоблавтотранс', 'carrier', 'https://mogobltrans.by/', 'Официальные расписания предприятия; электронные билеты учитываются через билетную систему автовокзала'),
  checkSource('autosevlad', 'АвтоСевлад', 'carrier', 'https://на-вильнюс.бел/', 'Проходящий международный рейс; отдельная публичная выдача мест на участке Могилёв—Минск не обнаружена'),
  checkSource('grandexpress-vash', 'Ваш Экспресс', 'carrier', 'https://vash-exspress.by/', 'Зеркало ГрандЭкспресс; рейсы учтены через основной сайт'),
  checkSource('grandexpress-hutki', 'HutkiBus', 'carrier', 'https://hutkibus.by/', 'Зеркало ГрандЭкспресс; рейсы учтены через основной сайт'),
  checkSource('infobus', 'INFOBUS', 'platform', 'https://infobus.by/bus/route/from-mogilev-to-minsk', 'Маршрутная страница доступна; без открытого API рейсы не импортируются'),
  checkSource('ticketbus', 'TicketBus', 'platform', 'https://ticketbus.by/'),
  checkSource('tutu', 'Tutu', 'platform', 'https://by.tutu.travel/', 'Проверка доступности; без открытого API'),
  checkSource('yandex-schedules', 'Яндекс Расписания', 'platform', 'https://yandex.by/maps/', 'Проверка доступности; без API-ключа рейсы не импортируются'),
  checkSource('visit-tour', 'Визит-Тур', 'carrier', 'https://vt.by/', 'Публичный поиск содержит проходящие рейсы, но HTML-выдача нестабильно возвращает чужие направления; источник не импортируется до надёжного сопоставления сегмента'),
  checkSource('two-capitals', 'Две столицы', 'platform', 'https://2stolicy.com/', 'Отдельный диспетчерский сайт; рейсы могут совпадать с Минск Экспресс'),
  checkSource('new-line-7311', '7311 / Новая линия', 'platform', 'https://7311.by/', 'Информационный сервис временно недоступен; рейсы Новой линии импортируются напрямую из BusPro'),
  checkSource('konduktor', 'Konduktor', 'platform', 'https://konduktor.by/', 'Билетная площадка; подтверждённая отдельная выдача Могилёв—Минск не обнаружена'),
  checkSource('mogilev-bus-station', 'Автовокзал Могилёва', 'platform', 'https://avtovokzal-mogilev.by/', 'Официальный сайт направляет покупку билетов на TicketBus'),
  checkSource('intercars', 'Intercars Europe', 'carrier', 'https://www.intercars-tickets.com/'),
  checkSource('ecolines', 'Ecolines', 'carrier', 'https://ecolines.by/by/ru'),
])

let atlasResult: SourceResult
if (process.env.SKIP_BROWSER_SOURCES === '1') {
  atlasResult = { trips: [], health: { id: 'atlas', name: 'Atlas', kind: 'platform', url: 'https://atlasbus.by/', status: 'unchecked', checkedAt: generatedAt, message: 'Браузерный источник пропущен настройкой' } }
} else {
  atlasResult = await collectAtlas()
}

const results = [...directResults, atlasResult]
const previous = localOnly ? { snapshots: {} as Partial<Record<Direction, DirectionSnapshot>> } : await readPrevious()
const failedIds = new Set(results.filter((result) => result.health.status === 'error').map((result) => result.health.id))
const currentTrips = results.flatMap((result) => result.trips)

for (const direction of ['mogilev-minsk', 'minsk-mogilev'] as const) {
  const snapshot = previous.snapshots[direction]
  if (!snapshot || isSnapshotExpired(snapshot.generatedAt)) continue
  for (const trip of snapshot.trips) {
    if (trip.serviceDate < localDate()) continue
    const failedOptions = trip.bookingOptions.filter((option) => failedIds.has(option.sourceId))
    if (!failedOptions.length) continue
    currentTrips.push({ ...trip, bookingOptions: failedOptions })
  }
}

const health: SourceHealth[] = results.map((result) => {
  if (result.health.status !== 'error') return result.health
  const hadPrevious = Object.values(previous.snapshots).some((snapshot) => snapshot?.trips.some((trip) => trip.bookingOptions.some((option) => option.sourceId === result.health.id)))
  return hadPrevious ? { ...result.health, status: 'stale', message: `Показаны последние данные: ${result.health.message || 'источник недоступен'}` } : result.health
})

const version = generatedAt.replace(/[-:.TZ]/g, '').slice(0, 14)
const snapshots = (['mogilev-minsk', 'minsk-mogilev'] as const).map((direction): DirectionSnapshot => ({
  schemaVersion: 1,
  direction,
  generatedAt,
  trips: mergeExactTrips(currentTrips.filter((trip): trip is Trip => trip.direction === direction)),
  sources: health,
}))
const manifest: SnapshotManifest = {
  schemaVersion: 1,
  version,
  generatedAt,
  directions: {
    'mogilev-minsk': `snapshot:${version}:mogilev-minsk`,
    'minsk-mogilev': `snapshot:${version}:minsk-mogilev`,
  },
  sources: health,
}

if (localOnly) {
  const target = resolve('data/snapshots')
  await mkdir(target, { recursive: true })
  await writeFile(resolve(target, 'sample.json'), JSON.stringify({ manifest, snapshots }, null, 2), 'utf8')
  console.log(`Saved ${snapshots.reduce((sum, snapshot) => sum + snapshot.trips.length, 0)} trips to data/snapshots/sample.json`)
} else {
  await publishSnapshots(manifest, snapshots)
  console.log(`Published version ${version}: ${snapshots.map((snapshot) => `${snapshot.direction}=${snapshot.trips.length}`).join(', ')}`)
}
