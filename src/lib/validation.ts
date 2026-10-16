import registry from '../../data/sources.json'
import { isValidDate, isValidInstant, localDate } from './date'
import type { Direction, DirectionSnapshot, SnapshotManifest, Trip, TripsResponse } from '../types'

export const DIRECTIONS = ['mogilev-minsk', 'minsk-mogilev'] as const
const hosts = new Map(registry.map((source) => [source.id, new Set([new URL(source.url).hostname, new URL(source.bookingUrl).hostname])]))
const sourceHosts = new Map(registry.map((source) => [source.id, new Set([new URL(source.url).hostname, new URL(source.bookingUrl).hostname,
  ...('apiUrl' in source && typeof source.apiUrl === 'string' ? [new URL(source.apiUrl).hostname] : [])])]))
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 500
const numberOrNull = (value: unknown) => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
const availability = (value: unknown) => ['available', 'sold_out', 'unknown'].includes(String(value))
export const isDirection = (value: unknown): value is Direction => DIRECTIONS.includes(value as Direction)

export function safeBookingUrl(sourceId: string, value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !!hosts.get(sourceId)?.has(url.hostname)
  } catch { return false }
}

function safeSourceUrl(sourceId: string, value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port && !!sourceHosts.get(sourceId)?.has(url.hostname) }
  catch { return false }
}

export function isTrip(value: unknown): value is Trip {
  if (!object(value) || !text(value.id) || String(value.id).startsWith('demo-') || !isDirection(value.direction) || !isValidDate(value.serviceDate)
    || !isValidInstant(value.departureAt) || localDate(new Date(value.departureAt)) !== value.serviceDate
    || !isValidInstant(value.lastSeenAt) || !text(value.carrierId) || !text(value.carrierName)
    || !text(value.originStop) || !text(value.destinationStop) || value.currency !== 'BYN'
    || !['bus', 'train', 'minibus', 'unknown'].includes(String(value.vehicleType))
    || !numberOrNull(value.price) || !availability(value.availability) || !numberOrNull(value.durationMinutes)
    || (value.seats !== undefined && !(Number.isInteger(value.seats) && Number(value.seats) >= 0))
    || (value.arrivalAt !== null && (!isValidInstant(value.arrivalAt) || Date.parse(value.arrivalAt) <= Date.parse(value.departureAt)))
    || !Array.isArray(value.bookingOptions) || !value.bookingOptions.length) return false
  return value.bookingOptions.every((option: unknown) => object(option) && text(option.sourceId) && text(option.sourceName)
    && ['carrier', 'platform'].includes(String(option.sourceKind)) && typeof option.url === 'string'
    && safeBookingUrl(String(option.sourceId), option.url) && numberOrNull(option.price)
    && option.currency === 'BYN' && availability(option.availability)
    && (option.seats === undefined || (Number.isInteger(option.seats) && Number(option.seats) >= 0))
    && ['observedAt', 'priceObservedAt', 'availabilityObservedAt'].every((field) => option[field] === undefined || isValidInstant(option[field])))
}

function isSources(value: unknown): boolean {
  return Array.isArray(value) && value.every((source: unknown) => object(source) && text(source.id) && text(source.name)
    && ['carrier', 'platform'].includes(String(source.kind)) && typeof source.url === 'string'
    && safeSourceUrl(String(source.id), source.url) && ['ok', 'error', 'stale', 'unchecked'].includes(String(source.status))
    && ['checkedAt', 'lastSuccessAt', 'lastCompleteSuccessAt'].every((field) => source[field] === undefined || isValidInstant(source[field]))
    && (source.failureStreak === undefined || (Number.isInteger(source.failureStreak) && Number(source.failureStreak) >= 0))
    && (source.coverage === undefined || (Array.isArray(source.coverage) && source.coverage.every((item: unknown) =>
      object(item) && isDirection(item.direction) && isValidDate(item.date) && isValidInstant(item.checkedAt) && ['ok', 'error'].includes(String(item.status))))))
}

export function isSnapshot(value: unknown, direction: Direction): value is DirectionSnapshot {
  return object(value) && [1, 2].includes(Number(value.schemaVersion)) && value.direction === direction
    && isValidInstant(value.generatedAt) && Array.isArray(value.trips)
    && value.trips.every((trip: unknown) => isTrip(trip) && trip.direction === direction) && isSources(value.sources)
}

// Full snapshots are validated before publication. A request validates its selected date
// while scanning the rest only for envelope/direction corruption, keeping free Worker CPU bounded.
export function isSnapshotForDate(value: unknown, direction: Direction, date: string): value is DirectionSnapshot {
  return object(value) && [1, 2].includes(Number(value.schemaVersion)) && value.direction === direction
    && isValidInstant(value.generatedAt) && Array.isArray(value.trips) && isSources(value.sources)
    && value.trips.every((trip: unknown) => object(trip) && trip.direction === direction
      && typeof trip.serviceDate === 'string' && (trip.serviceDate !== date || isTrip(trip)))
}

export function isManifest(value: unknown): value is SnapshotManifest {
  return object(value) && [1, 2].includes(Number(value.schemaVersion)) && text(value.version)
    && isValidInstant(value.generatedAt) && object(value.directions)
    && DIRECTIONS.every((direction) => text((value.directions as Record<string, unknown>)[direction]))
    && isSources(value.sources)
    && (value.previousDirections === undefined || (object(value.previousDirections)
      && DIRECTIONS.every((direction) => (value.previousDirections as Record<string, unknown>)[direction] === undefined
        || text((value.previousDirections as Record<string, unknown>)[direction]))))
}

export function isTripsResponse(value: unknown, direction: Direction, date: string): value is TripsResponse {
  return object(value) && value.dataMode === 'live' && value.direction === direction && value.date === date
    && isValidInstant(value.generatedAt) && typeof value.stale === 'boolean'
    && Array.isArray(value.trips) && value.trips.every((trip: unknown) => isTrip(trip) && trip.direction === direction && trip.serviceDate === date)
    && isSources(value.sources)
}
