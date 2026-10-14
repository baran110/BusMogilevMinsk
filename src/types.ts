export type Direction = 'mogilev-minsk' | 'minsk-mogilev'
export type VehicleType = 'minibus' | 'bus' | 'train' | 'unknown'
export type AvailabilityStatus = 'available' | 'sold_out' | 'unknown'
export type SourceKind = 'carrier' | 'platform'
export type SourceStatus = 'ok' | 'stale' | 'error' | 'unchecked'

export interface BookingOption {
  sourceId: string
  sourceName: string
  sourceKind: SourceKind
  url: string
  price: number | null
  currency: 'BYN'
  availability: AvailabilityStatus
  seats?: number
  observedAt?: string
  priceObservedAt?: string
  availabilityObservedAt?: string
  lastKnown?: boolean
}

export interface Trip {
  id: string
  direction: Direction
  serviceDate: string
  departureAt: string
  arrivalAt: string | null
  durationMinutes: number | null
  carrierId: string
  carrierName: string
  vehicleType: VehicleType
  vehicleName?: string
  vehicleNumber?: string
  routeNumber?: string
  originStop: string
  destinationStop: string
  price: number | null
  currency: 'BYN'
  availability: AvailabilityStatus
  seats?: number
  bookingOptions: BookingOption[]
  lastSeenAt: string
  lastKnown?: boolean
}

export interface SourceCoverage {
  direction: Direction
  date: string
  checkedAt: string
  status: 'ok' | 'error'
  message?: string
}

export interface SourceHealth {
  id: string
  name: string
  kind: SourceKind
  url: string
  status: SourceStatus
  lastSuccessAt?: string
  checkedAt?: string
  tripsFound?: number
  message?: string
  coverage?: SourceCoverage[]
}

export interface TripsResponse {
  direction: Direction
  date: string
  generatedAt: string
  stale: boolean
  trips: Trip[]
  sources: SourceHealth[]
  dataMode?: 'live'
  partial?: boolean
  usedBackup?: boolean
}

export interface DirectionSnapshot {
  schemaVersion: 1 | 2
  direction: Direction
  generatedAt: string
  trips: Trip[]
  sources: SourceHealth[]
}

export interface SnapshotManifest {
  schemaVersion: 1 | 2
  version: string
  generatedAt: string
  directions: Record<Direction, string>
  sources: SourceHealth[]
  previousDirections?: Partial<Record<Direction, string>>
  previousVersion?: string
  mode?: 'near' | 'full'
}

export interface SourceRegistryEntry {
  id: string
  name: string
  kind: SourceKind
  url: string
  bookingUrl: string
  adapter: 'transporter-api' | 'buspro' | 'atlas' | 'bzd-html' | 'availability' | 'link-only'
  enabled: boolean
  note?: string
  apiUrl?: string
  companyId?: number
  cityIds?: { mogilev: number; minsk: number }
}
