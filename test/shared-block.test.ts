import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const MARKER = '// ---- Shared renderer'

test('keeps the shared renderer block at the hash pinned in the parity fixture shared with ui-backend', () => {
  // Hashed bytes: from the start of the first line beginning with the marker to the end of report.ts.
  const source = readFileSync(new URL('../src/report.ts', import.meta.url))
  const marker = source.indexOf(`\n${MARKER}`) + 1
  assert.ok(marker > 0, 'shared renderer marker line not found in src/report.ts')
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity.json', import.meta.url), 'utf8')) as { sharedBlockSha256: string }
  const hash = createHash('sha256').update(source.subarray(marker)).digest('hex')
  assert.equal(
    hash,
    fixture.sharedBlockSha256,
    'report.ts shared block changed: update sharedBlockSha256 in test/fixtures/parity.json and copy both the block and parity.json to ui-backend (src/services/githubDrafttCi/report/scanReport.ts, src/__tests__/fixtures/parity.json)',
  )
})
