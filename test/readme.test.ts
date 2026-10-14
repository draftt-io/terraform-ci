import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
const actionYml = readFileSync(new URL('../action.yml', import.meta.url), 'utf8')
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

test('the README names no modes, rulesets or the retired draftt-ci host', () => {
  for (const banned of ['advisory', 'blocking', 'ruleset', 'draftt-ci.draftt.io']) {
    assert.equal(readme.toLowerCase().includes(banned), false, `README mentions ${banned}`)
  }
})

test('the README carries the spec §9 docs lines, the upgrade note and the api.draftt.io upload URL', () => {
  for (const line of [
    'The Draftt CI check never fails: it completes as success when the plan has no policy violations, and as neutral when it has some or when no plan arrived.',
    "Don't add the Draftt check as a required status check: while it waits for a plan it is pending, and a required pending check blocks merging until the timeout.",
    'fail-on-violations no longer fails the check or the job in any mode',
    'https://api.draftt.io/ci/v1/scans',
  ]) {
    // Code formatting around input names does not count as a difference.
    assert.ok(readme.replaceAll('`', '').includes(line), `README lacks: ${line}`)
  }
})

test('action.yml no longer says a mode decides whether the check fails', () => {
  for (const banned of ['advisory', 'blocking', 'decides whether the check fails']) {
    assert.equal(actionYml.includes(banned), false, `action.yml mentions ${banned}`)
  }
})

test('the package is v2.0.0-rc.2', () => {
  assert.equal(packageJson.version, '2.0.0-rc.2')
})
