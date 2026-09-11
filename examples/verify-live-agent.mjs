import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const decisions = new Map()
const answersOnRead = new Map()
const server = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
  if (request.method === 'POST' && request.url === '/enroll') {
    assert.equal(body.externalId, 'customer_1')
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ universalLink: 'https://example.invalid/test-enrollment' }))
  } else if (request.method === 'POST' && request.url === '/decisions') {
    assert.equal(body.wait, false)
    assert.equal(body.requireReachable, true)
    assert.equal(body.expiresInSeconds, 3600)
    assert.equal(body.callbackUrl, undefined)
    assert.equal(body.externalId, 'customer_1')
    const existing = [...decisions.values()].find((decision) => decision.idempotencyKey === body.idempotencyKey)
    const decision = existing ?? { ...body, decisionId: `decision_${decisions.size}`, status: 'pending', value: null, options: body.options ?? null, reachable: true, answered: false }
    decisions.set(decision.decisionId, decision)
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(decision))
  } else {
    const decision = decisions.get(request.url.split('/').at(-1))
    response.writeHead(decision ? 200 : 404, { 'content-type': 'application/json' })
    response.end(JSON.stringify(decision ?? { error: 'not_found' }))
    if (decision && answersOnRead.has(decision.decisionId)) {
      Object.assign(decision, { status: 'answered', answered: true, value: answersOnRead.get(decision.decisionId) })
      answersOnRead.delete(decision.decisionId)
    }
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const directory = mkdtempSync(join(tmpdir(), 'pushary-mastra-live-http-'))
const env = { ...process.env, PUSHARY_API_KEY: 'pk_test.sk_test', PUSHARY_EXTERNAL_ID: 'customer_1', PUSHARY_BASE_URL: `http://127.0.0.1:${server.address().port}` }
const run = (phase, scenario, overrides = {}) => promisify(execFile)(process.execPath, [fileURLToPath(new URL('./durable-agent.mjs', import.meta.url)), '--live', phase, directory, scenario], { env: { ...env, ...overrides }, timeout: 60_000 })
try {
  assert.match((await run('connect', 'approve')).stdout, /https:\/\/example.invalid\/test-enrollment/)
  for (const scenario of ['approve', 'deny', 'select', 'input']) {
    await run('start', scenario)
    const count = decisions.size
    await run('start', scenario)
    assert.equal(decisions.size, count, 'Restarting start must reuse the saved action')
    await assert.rejects(run('start', scenario, { PUSHARY_EXTERNAL_ID: 'different_customer' }))
    await assert.rejects(run('start', scenario, { PUSHARY_API_KEY: 'pk_other.sk_other' }))
    assert.match((await run('answer', scenario)).stdout, /"status":"pending"/)
    const decision = [...decisions.values()].at(-1)
    answersOnRead.set(decision.decisionId, { approve: 'yes', deny: 'no', select: 'other', input: 'Use the corrected shipping address' }[scenario])
    assert.match((await run('answer', scenario)).stdout, /"status":"pending"/)
    assert.match((await run('answer', scenario)).stdout, /recovered in a fresh process/)
    assert.match((await run('answer', scenario)).stdout, /"status":"duplicate"/)
    await assert.rejects(run('start', scenario))
    await assert.rejects(run('answer', scenario, { PUSHARY_EXTERNAL_ID: 'different_customer' }))
    await assert.rejects(run('start', scenario, { PUSHARY_API_KEY: 'pk_other.sk_other' }))
    assert.equal(decisions.size, count)
  }
  console.log('Live CLI HTTP checks passed: retry, pending, approve, deny, select, input, duplicate and customer isolation. Phone delivery is not simulated by this check.')
} finally {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
