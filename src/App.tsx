import { useEffect, useMemo, useState } from 'react'
import { fetchTrips } from './lib/api'
import {
  addDays,
  dateRange,
  directionCities,
  formatDuration,
  formatTime,
  formatUpdated,
  isDeparted,
  localDate,
  reverseDirection,
} from './lib/date'
import { chooseBestBooking } from './lib/trips'
import type { Direction, SourceHealth, Trip, TripsResponse, VehicleType } from './types'

type SortMode = 'time' | 'price' | 'duration'

interface Filters {
  timeFrom: string
  timeTo: string
  priceMin: number
  priceMax: number
  carrier: string
  vehicle: VehicleType | 'all'
  originStop: string
  destinationStop: string
  showSoldOut: boolean
}

const initialFilters: Filters = {
  timeFrom: '00:00',
  timeTo: '23:59',
  priceMin: 0,
  priceMax: 100,
  carrier: 'all',
  vehicle: 'all',
  originStop: 'all',
  destinationStop: 'all',
  showSoldOut: false,
}

const Icon = ({ name, size = 20 }: { name: 'swap' | 'filter' | 'clock' | 'bus' | 'train' | 'route' | 'arrow' | 'check' | 'close' | 'calendar' | 'source'; size?: number }) => {
  const paths: Record<string, React.ReactNode> = {
    swap: <><path d="M7 7h11l-3-3"/><path d="m18 7-3 3"/><path d="M17 17H6l3 3"/><path d="m6 17 3-3"/></>,
    filter: <><path d="M4 5h16"/><path d="M7 12h10"/><path d="M10 19h4"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    bus: <><rect x="4" y="3" width="16" height="16" rx="3"/><path d="M7 8h10M8 19v2m8-2v2M8 15h.01M16 15h.01"/></>,
    train: <><rect x="5" y="3" width="14" height="16" rx="4"/><path d="M8 8h8M8 14h.01M16 14h.01M8 21l2-2m6 2-2-2"/></>,
    route: <><circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h3a3 3 0 0 0 3-3V9a3 3 0 0 1 3-3"/></>,
    arrow: <><path d="M5 12h14"/><path d="m14 7 5 5-5 5"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    close: <><path d="m6 6 12 12"/><path d="m18 6-12 12"/></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4m8-4v4M3 10h18"/></>,
    source: <><path d="M12 3 4 7l8 4 8-4-8-4Z"/><path d="m4 12 8 4 8-4M4 17l8 4 8-4"/></>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

function DateStrip({ selected, onSelect }: { selected: string; onSelect: (date: string) => void }) {
  const dates = dateRange(localDate(), 30)
  return (
    <div className="date-strip" aria-label="Выберите дату поездки">
      {dates.map((date, index) => {
        const value = new Date(`${date}T12:00:00Z`)
        const weekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' }).format(value).replace('.', '')
        const day = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(value).replace('.', '')
        return (
          <button className={`date-chip ${selected === date ? 'active' : ''}`} key={date} onClick={() => onSelect(date)}>
            <span>{index === 0 ? 'сегодня' : index === 1 ? 'завтра' : weekday}</span>
            <strong>{day}</strong>
          </button>
        )
      })}
    </div>
  )
}

function FilterPanel({ filters, setFilters, trips, mobile, close }: {
  filters: Filters
  setFilters: (filters: Filters) => void
  trips: Trip[]
  mobile?: boolean
  close?: () => void
}) {
  const carriers = [...new Set(trips.map((trip) => trip.carrierName))].sort()
  const origins = [...new Set(trips.map((trip) => trip.originStop))].sort()
  const destinations = [...new Set(trips.map((trip) => trip.destinationStop))].sort()
  const update = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters({ ...filters, [key]: value })
  return (
    <aside className={`filters ${mobile ? 'mobile-sheet' : ''}`} aria-label="Фильтры рейсов">
      <div className="filter-heading">
        <div><span className="eyebrow">Настройте выдачу</span><h2>Фильтры</h2></div>
        {mobile && <button className="icon-button" onClick={close} aria-label="Закрыть фильтры"><Icon name="close" /></button>}
      </div>
      <div className="filter-block">
        <label>Время отправления</label>
        <div className="split-inputs">
          <div><span>с</span><input type="time" value={filters.timeFrom} onChange={(event) => update('timeFrom', event.target.value)} /></div>
          <div><span>до</span><input type="time" value={filters.timeTo} onChange={(event) => update('timeTo', event.target.value)} /></div>
        </div>
      </div>
      <div className="filter-block">
        <label>Цена, BYN</label>
        <div className="split-inputs">
          <div><span>от</span><input type="number" min="0" max="100" value={filters.priceMin} onChange={(event) => update('priceMin', Number(event.target.value))} /></div>
          <div><span>до</span><input type="number" min="0" max="100" value={filters.priceMax} onChange={(event) => update('priceMax', Number(event.target.value))} /></div>
        </div>
      </div>
      <div className="filter-block">
        <label htmlFor="carrier">Перевозчик</label>
        <select id="carrier" value={filters.carrier} onChange={(event) => update('carrier', event.target.value)}>
          <option value="all">Все перевозчики</option>
          {carriers.map((carrier) => <option key={carrier} value={carrier}>{carrier}</option>)}
        </select>
      </div>
      <div className="filter-block">
        <label>Тип транспорта</label>
        <div className="segmented">
          {([['all', 'Все'], ['minibus', 'Маршрутки'], ['bus', 'Автобусы'], ['train', 'Поезда']] as const).map(([value, label]) => (
            <button key={value} className={filters.vehicle === value ? 'selected' : ''} onClick={() => update('vehicle', value)}>{label}</button>
          ))}
        </div>
      </div>
      <div className="filter-block">
        <label htmlFor="origin">Место отправления</label>
        <select id="origin" value={filters.originStop} onChange={(event) => update('originStop', event.target.value)}>
          <option value="all">Любая остановка</option>
          {origins.map((stop) => <option key={stop} value={stop}>{stop}</option>)}
        </select>
      </div>
      <div className="filter-block">
        <label htmlFor="destination">Место прибытия</label>
        <select id="destination" value={filters.destinationStop} onChange={(event) => update('destinationStop', event.target.value)}>
          <option value="all">Любая остановка</option>
          {destinations.map((stop) => <option key={stop} value={stop}>{stop}</option>)}
        </select>
      </div>
      <label className="check-row">
        <input type="checkbox" checked={filters.showSoldOut} onChange={(event) => update('showSoldOut', event.target.checked)} />
        <span className="fake-check"><Icon name="check" size={15} /></span>
        Показывать рейсы без мест
      </label>
      <button className="reset-button" onClick={() => setFilters(initialFilters)}>Сбросить фильтры</button>
      {mobile && <button className="primary full" onClick={close}>Показать рейсы</button>}
    </aside>
  )
}

function TripCard({ trip, cheapest }: { trip: Trip; cheapest: boolean }) {
  const best = chooseBestBooking(trip.bookingOptions)
  const soldOut = trip.availability === 'sold_out'
  const vehicleLabel = trip.vehicleType === 'train' ? 'Поезд' : trip.vehicleType === 'bus' ? 'Автобус' : 'Маршрутка'
  return (
    <article className={`trip-card ${soldOut ? 'sold-out' : ''}`}>
      <div className="trip-card-top">
        <div className="carrier-mark">{trip.carrierName.split(/\s+/).filter((part) => !/^(ооо|ип|чп|оао|чтуп)$/i.test(part)).slice(0, 2).map((part) => part[0]).join('').toUpperCase()}</div>
        <div className="carrier-info"><span>{vehicleLabel}</span><strong>{trip.carrierName}</strong></div>
        <div className="trip-badges">
          {cheapest && !soldOut && <span className="badge best">Лучшая цена</span>}
          <span className={`badge ${soldOut ? 'muted' : 'available'}`}>{soldOut ? 'Нет мест' : trip.seats ? `${trip.seats} ${trip.seats === 1 ? 'место' : trip.seats < 5 ? 'места' : 'мест'}` : 'Места есть'}</span>
        </div>
      </div>
      <div className="trip-main">
        <div className="timeline">
          <div className="time-point"><strong>{formatTime(trip.departureAt)}</strong><span>{trip.originStop}</span></div>
          <div className="route-line"><i></i><div><Icon name="clock" size={15} /> {formatDuration(trip.durationMinutes)}</div><i></i></div>
          <div className="time-point end"><strong>{formatTime(trip.arrivalAt)}</strong><span>{trip.destinationStop}</span></div>
        </div>
        <div className="price-box">
          <span>за 1 пассажира</span>
          <strong>{trip.price > 0 ? <>{trip.price.toFixed(trip.price % 1 ? 2 : 0)} <small>BYN</small></> : 'Уточнить'}</strong>
        </div>
      </div>
      <div className="trip-card-bottom">
        <div className="vehicle"><Icon name={trip.vehicleType === 'train' ? 'train' : 'bus'} size={17} /><span>{trip.vehicleName || 'Транспорт перевозчика'}{trip.vehicleType === 'train' && trip.routeNumber ? ` · № ${trip.routeNumber}` : ''}{trip.vehicleNumber ? ` · ${trip.vehicleNumber}` : ''}</span></div>
        <div className="source-label">Данные: <strong>{best.sourceName}</strong></div>
        <a className={`booking-button ${soldOut ? 'secondary' : ''}`} href={best.url} target="_blank" rel="noopener noreferrer">
          {soldOut ? 'Проверить на сайте' : 'Перейти к бронированию'} <Icon name="arrow" size={17} />
        </a>
      </div>
      {trip.bookingOptions.length > 1 && (
        <details className="alternatives">
          <summary>Ещё {trip.bookingOptions.length - 1} {trip.bookingOptions.length === 2 ? 'вариант бронирования' : 'варианта бронирования'}</summary>
          <div>{trip.bookingOptions.filter((option) => option !== best).map((option) => <a key={`${option.sourceId}-${option.url}`} href={option.url} target="_blank" rel="noopener noreferrer">{option.sourceName}<span>{option.price} BYN</span></a>)}</div>
        </details>
      )}
    </article>
  )
}

function SourcesPanel({ sources, close }: { sources: SourceHealth[]; close: () => void }) {
  const labels: Record<SourceHealth['status'], string> = { ok: 'Работает', stale: 'Задержка', error: 'Недоступен', unchecked: 'Проверяется' }
  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <section className="sources-panel" role="dialog" aria-modal="true" aria-label="Источники данных">
        <div className="sources-header"><div><span className="eyebrow">Прозрачная выдача</span><h2>Источники данных</h2></div><button className="icon-button" onClick={close} aria-label="Закрыть"><Icon name="close" /></button></div>
        <p className="sources-intro">Мы показываем, откуда получен каждый рейс. Прямые сайты перевозчиков имеют приоритет перед площадками бронирования.</p>
        <div className="source-list">
          {sources.map((source) => (
            <a href={source.url} target="_blank" rel="noopener noreferrer" className="source-item" key={source.id}>
              <div className="source-icon"><Icon name="source" /></div>
              <div><strong>{source.name}</strong><span>{source.id === 'bzd' ? 'Официальный железнодорожный оператор' : source.kind === 'carrier' ? 'Сайт перевозчика' : 'Площадка бронирования'}{source.message ? ` · ${source.message}` : ''}</span></div>
              <span className={`source-status ${source.status}`}>{labels[source.status]}</span>
            </a>
          ))}
        </div>
        <div className="source-note">Источники старше 24 часов автоматически исключаются из выдачи. Мы не оформляем билеты и не принимаем оплату.</div>
      </section>
    </div>
  )
}

export default function App() {
  const [direction, setDirection] = useState<Direction>('mogilev-minsk')
  const [selectedDate, setSelectedDate] = useState(localDate())
  const [filters, setFilters] = useState(initialFilters)
  const [sort, setSort] = useState<SortMode>('time')
  const [response, setResponse] = useState<TripsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [demo, setDemo] = useState(false)
  const [mobileFilters, setMobileFilters] = useState(false)
  const [showSources, setShowSources] = useState(false)
  const [clock, setClock] = useState(new Date())
  const cities = directionCities[direction]

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    fetchTrips(direction, selectedDate, controller.signal).then(({ data, demo: isDemo }) => {
      setResponse(data)
      setDemo(isDemo)
      setLoading(false)
    }).catch(() => setLoading(false))
    return () => controller.abort()
  }, [direction, selectedDate])

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    document.body.style.overflow = mobileFilters || showSources ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [mobileFilters, showSources])

  const trips = response?.trips || []
  const visibleTrips = useMemo(() => {
    const filtered = trips.filter((trip) => {
      const time = formatTime(trip.departureAt)
      return !isDeparted(trip.departureAt, clock)
        && (filters.showSoldOut || trip.availability !== 'sold_out')
        && time >= filters.timeFrom && time <= filters.timeTo
        && trip.price >= filters.priceMin && trip.price <= filters.priceMax
        && (filters.carrier === 'all' || trip.carrierName === filters.carrier)
        && (filters.vehicle === 'all' || trip.vehicleType === filters.vehicle)
        && (filters.originStop === 'all' || trip.originStop === filters.originStop)
        && (filters.destinationStop === 'all' || trip.destinationStop === filters.destinationStop)
    })
    return filtered.sort((a, b) => sort === 'price' ? a.price - b.price || a.departureAt.localeCompare(b.departureAt) : sort === 'duration' ? a.durationMinutes - b.durationMinutes : a.departureAt.localeCompare(b.departureAt))
  }, [trips, filters, sort, clock])
  const minPrice = visibleTrips.length ? Math.min(...visibleTrips.filter((trip) => trip.availability !== 'sold_out').map((trip) => trip.price)) : 0

  const swap = () => {
    setDirection(reverseDirection(direction))
    setFilters(initialFilters)
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="На главную"><span className="brand-icon"><Icon name="bus" size={25} /></span><span><strong>ММ</strong><small>маршрутки</small></span></a>
        <nav><a href="#trips">Рейсы</a><button onClick={() => setShowSources(true)}>Источники</button><a href="#about">О сервисе</a></nav>
        <div className="header-note"><span></span> Данные обновляются каждый час</div>
      </header>

      <main id="top">
        <section className="hero">
          <div className="hero-copy">
            <span className="eyebrow light">Все перевозчики в одном месте</span>
            <h1>Из Могилёва<br />в Минск <em>выгодно</em></h1>
            <p>Сравнивайте маршрутки, автобусы и поезда. Бронируйте напрямую у оператора.</p>
          </div>
          <div className="road-art" aria-hidden="true">
            <div className="sun"></div><div className="city city-left"></div><div className="city city-right"></div>
            <div className="road"><span></span><div className="mini-bus"><b></b><i></i><i></i></div></div>
          </div>
          <div className="search-card">
            <div className="route-input"><span>Откуда</span><strong>{cities.from}</strong></div>
            <button className="swap-button" onClick={swap} aria-label="Поменять города местами"><Icon name="swap" /></button>
            <div className="route-input"><span>Куда</span><strong>{cities.to}</strong></div>
            <label className="date-input"><span>Дата поездки</span><div><Icon name="calendar" size={18} /><input type="date" min={localDate()} max={addDays(localDate(), 29)} value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} /></div></label>
            <a className="primary search-action" href="#trips">Найти рейсы <Icon name="arrow" size={18} /></a>
          </div>
        </section>

        <section className="date-section"><div className="content-width"><DateStrip selected={selectedDate} onSelect={setSelectedDate} /></div></section>

        <section className="results-section" id="trips">
          <div className="content-width">
            {demo && <div className="demo-banner"><strong>Демонстрационный режим.</strong> Подключите Workers KV, чтобы показывать ежечасно собранные данные.</div>}
            {response?.stale && <div className="stale-banner">Обновление источников задерживается. Показан последний успешный снимок.</div>}
            <div className="results-heading">
              <div><span className="eyebrow">{cities.from} → {cities.to}</span><h2>{loading ? 'Ищем рейсы…' : `${visibleTrips.length} ${visibleTrips.length % 10 === 1 && visibleTrips.length !== 11 ? 'рейс' : visibleTrips.length % 10 > 1 && visibleTrips.length % 10 < 5 ? 'рейса' : 'рейсов'}`}</h2><p>{response ? `Обновлено ${formatUpdated(response.generatedAt)}` : 'Получаем данные перевозчиков'}</p></div>
              <div className="results-actions">
                <button className="mobile-filter-button" onClick={() => setMobileFilters(true)}><Icon name="filter" /> Фильтры</button>
                <label>Сначала <select value={sort} onChange={(event) => setSort(event.target.value as SortMode)}><option value="time">ранние</option><option value="price">дешёвые</option><option value="duration">быстрые</option></select></label>
              </div>
            </div>
            <div className="results-layout">
              <FilterPanel filters={filters} setFilters={setFilters} trips={trips} />
              <div className="trip-list">
                {loading ? Array.from({ length: 4 }, (_, index) => <div className="trip-skeleton" key={index}></div>) : visibleTrips.length ? visibleTrips.map((trip) => <TripCard key={trip.id} trip={trip} cheapest={trip.price === minPrice} />) : (
                  <div className="empty-state"><div><Icon name="route" size={34} /></div><h3>Подходящих рейсов не найдено</h3><p>Попробуйте выбрать другую дату или сбросить фильтры.</p><button className="primary" onClick={() => setFilters(initialFilters)}>Сбросить фильтры</button></div>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="trust-section" id="about">
          <div className="content-width trust-grid">
            <div><span className="eyebrow light">Как это работает</span><h2>Мы сравниваем.<br />Вы выбираете.</h2></div>
            <div className="trust-item"><span>01</span><strong>Собираем расписания</strong><p>Проверяем прямые сайты и официальные площадки каждый час.</p></div>
            <div className="trust-item"><span>02</span><strong>Убираем повторы</strong><p>Один физический рейс — одна карточка, даже если он продаётся в нескольких местах.</p></div>
            <div className="trust-item"><span>03</span><strong>Ведём к перевозчику</strong><p>Не принимаем оплату — вы завершаете бронирование на официальном сайте.</p></div>
          </div>
        </section>
      </main>

      <footer><div className="content-width"><div className="brand footer-brand"><span className="brand-icon"><Icon name="bus" size={22} /></span><span><strong>ММ</strong><small>маршрутки</small></span></div><p>Независимый сервис сравнения. Информация носит справочный характер.</p><button onClick={() => setShowSources(true)}>Все источники →</button></div></footer>

      {mobileFilters && <div className="overlay filters-overlay"><FilterPanel mobile filters={filters} setFilters={setFilters} trips={trips} close={() => setMobileFilters(false)} /></div>}
      {showSources && <SourcesPanel sources={response?.sources || []} close={() => setShowSources(false)} />}
    </div>
  )
}
