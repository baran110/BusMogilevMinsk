export const ACCESS_STORAGE_KEY = 'mm-access-grant-v1'

export const ACCESS_HASHES = [
  '4a1c9de3c0d63e2fd35a0df618bd7583c883503bd8c2489417a5c08d8f293750',
  '7efd1b833db69071397f6c18441bff32a35fd4812a4d12ab00d0047a7599bf56',
  '3aea20dd32762285339fec168c4c3f1977eb7daed5dd507418bb181a69a6cafb',
] as const

export function normalizeAccessKey(value: string): string {
  return value.trim().toUpperCase()
}

export async function hashAccessKey(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeAccessKey(value))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function isAccessHash(value: string | null): boolean {
  return ACCESS_HASHES.includes(value as (typeof ACCESS_HASHES)[number])
}
