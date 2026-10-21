import { isRecord } from './objects.ts'
import type { SanitizedPlan } from './plan.ts'
import type { SourceLocator } from './report.ts'
import type { SourceMapEntry } from './request.ts'

export const MAX_SOURCE_MAP_ENTRIES = 100_000
const MAPPED_ACTIONS = new Set(['create', 'update', 'no-op'])

// Address to file and line for every resource the server might flag. The server resolves a
// flagged component by sourceAddress ?? address against these exact keys; no normalisation here.
// Capped at the server's own limit; the caller warns when the cap was hit.
export async function buildSourceMap(
  plan: SanitizedPlan,
  locator: SourceLocator,
): Promise<{ sourceMap: Record<string, SourceMapEntry>; capped: boolean }> {
  const sourceMap: Record<string, SourceMapEntry> = {}
  let entries = 0
  for (const resource of plan.resource_changes) {
    if (resource.mode !== 'managed' || typeof resource.address !== 'string' || Object.hasOwn(sourceMap, resource.address)) continue
    const change = resource.change
    const actions = isRecord(change) && Array.isArray(change.actions) ? change.actions.filter((action): action is string => typeof action === 'string') : []
    if (!actions.some((action) => MAPPED_ACTIONS.has(action))) continue
    const mapping = await locator.locate({ address: resource.address })
    if (mapping.kind !== 'found') continue
    if (entries >= MAX_SOURCE_MAP_ENTRIES) return { sourceMap, capped: true }
    sourceMap[resource.address] = { path: mapping.location.path, startLine: mapping.location.startLine }
    entries += 1
  }
  return { sourceMap, capped: false }
}
