export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid API response: ${field}`)
  return value
}

export function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid API response: ${field}`)
  return value
}

export function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid API response: ${field}`)
  return value
}
