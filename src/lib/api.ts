import { demoResponse } from '../data/demo'
import type { Direction, TripsResponse } from '../types'

export async function fetchTrips(direction: Direction, date: string, signal?: AbortSignal): Promise<{ data: TripsResponse; demo: boolean }> {
  try {
    const response = await fetch(`/api/trips?direction=${direction}&date=${date}`, { signal })
    if (!response.ok) throw new Error(`API ${response.status}`)
    const data = await response.json() as TripsResponse
    return { data, demo: false }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    return { data: demoResponse(direction, date), demo: true }
  }
}
