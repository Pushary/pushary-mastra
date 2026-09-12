import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createHash } from 'node:crypto'
import { Agent } from '@mastra/core/agent'
import { Mastra } from '@mastra/core/mastra'
import { createTool } from '@mastra/core/tools'
import { LibSQLStore } from '@mastra/libsql'
import { z } from 'zod'
import { createPusharyServer } from '@pushary/server'
import { connect, requirePusharyExternalId, createPusharyDeferredAskTool, openPusharyAgentReview, resumePusharyAgentReview } from '../dist/index.js'
import { createReviewStore } from './review-store.mjs'

const { values, positionals } = parseArgs({ options: { live: { type: 'boolean', default: false } }, allowPositionals: true })
const [phase, folder, scenario = 'approve'] = z.tuple([
  z.enum(['connect', 'start', 'answer']).optional(),
  z.string().min(1).optional(),
  z.enum(['approve', 'deny', 'select', 'input']).optional(),
]).parse([positionals[0], positionals[1], positionals[2]])
assert.ok(positionals.length <= 3, 'Usage: durable-agent.mjs [--live] connect|start|answer DIRECTORY approve|deny|select|input')
const live = values.live
const config = live ? z.object({
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
}).parse({ apiKey: process.env.PUSHARY_API_KEY, baseUrl: process.env.PUSHARY_BASE_URL })
  : { apiKey: 'pk_simulation.sk_simulation', baseUrl: 'https://pushary.invalid/api/v1/server' }
const externalId = live ? requirePusharyExternalId(process.env.PUSHARY_EXTERNAL_ID) : ' customer_1 '
if (phase === 'connect') {
  assert.ok(live, 'Connecting a phone requires --live')
  const enrollment = await connect(config, externalId)
  console.log(`Open this private, single-use enrollment link on the test phone: ${enrollment.universalLink}`)
} else if (!phase && !live) {
  const directory = mkdtempSync(join(tmpdir(), 'pushary-mastra-restart-'))
  for (const name of ['approve', 'deny', 'select', 'input']) {
    for (const step of ['start', 'answer']) {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), step, directory, name], { encoding: 'utf8', timeout: 60_000 })
      assert.equal(child.status, 0, `${name}/${step}: ${child.stdout}\n${child.stderr}`)
      process.stdout.write(child.stdout)
    }
  }
  console.log(`Real Mastra restart checks passed. SQLite evidence: ${directory}`)
} else {
  assert.ok(phase && folder, 'Pass start or answer and a persistent directory; reuse it after a restart.')
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const database = new DatabaseSync(join(folder, `${scenario}-app.sqlite`))
  database.exec(`
    CREATE TABLE IF NOT EXISTS simulated_decisions (id TEXT PRIMARY KEY, request_key TEXT UNIQUE, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS effects (id TEXT PRIMARY KEY, calls INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS demo_identity (id INTEGER PRIMARY KEY CHECK(id = 1), payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS demo_outputs (decision_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
  `)
  const identity = JSON.stringify({ live, externalId, baseUrl: config.baseUrl ?? 'https://pushary.com/api/v1/server', credential: createHash('sha256').update(config.apiKey).digest('hex') })
  database.prepare('INSERT OR IGNORE INTO demo_identity VALUES (1, ?)').run(identity)
  assert.ok(database.prepare('SELECT payload FROM demo_identity WHERE id = 1').get().payload === identity, 'The customer, environment, or credential changed. Restore the original configuration to resume this action.')
  if (!live) globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST' && String(url).endsWith('/decisions')) {
      const body = JSON.parse(init.body)
      const existing = database.prepare('SELECT payload FROM simulated_decisions WHERE request_key = ?').get(body.idempotencyKey)
      if (existing) return new Response(existing.payload)
      const decisionId = `decision_${body.idempotencyKey}`
      const decision = { ...body, decisionId, status: 'pending', answered: false, value: null, externalId: null, options: body.options ?? null }
      database.prepare('INSERT INTO simulated_decisions VALUES (?, ?, ?)').run(decisionId, body.idempotencyKey, JSON.stringify(decision))
      return Response.json(decision)
    }
    const row = database.prepare('SELECT payload FROM simulated_decisions WHERE id = ?').get(String(url).split('/').at(-1))
    assert.ok(row, `Unexpected HTTP request: ${url}`)
    return new Response(row.payload)
  }
  const question = scenario === 'select' || scenario === 'input'
  const request = question ? {
    question: scenario === 'select'
      ? 'Choose yes to test a customer choice. This answer will not authorize a refund.'
      : 'Type yes to test a written answer. This answer will not authorize a refund.',
    type: scenario,
    ...(scenario === 'select' ? { options: ['yes', 'other'] } : {}),
  } : { orderId: 'order_1', amount: 20 }
  const toolName = question ? 'askHuman' : 'refund'
  const nextContent = (prompt) => prompt.some((message) => message.role === 'tool')
    ? { content: [{ type: 'text', text: 'Finished' }], finishReason: 'stop' }
    : { content: [{ type: 'tool-call', toolCallId: 'call_1', toolName, input: JSON.stringify(request) }], finishReason: 'tool-calls' }
  const model = {
    specificationVersion: 'v2', modelId: 'scripted-model', provider: 'simulation', supportedUrls: {},
    doGenerate: async ({ prompt }) => ({ ...nextContent(prompt), usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, warnings: [] }),
    doStream: async ({ prompt }) => {
      const next = nextContent(prompt)
      const events = [{ type: 'stream-start', warnings: [] }, ...(next.finishReason === 'stop'
        ? [{ type: 'text-start', id: 'text_1' }, { type: 'text-delta', id: 'text_1', delta: 'Finished' }, { type: 'text-end', id: 'text_1' }]
        : next.content), { type: 'finish', finishReason: next.finishReason, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }]
      return { stream: new ReadableStream({ start(controller) { events.forEach((event) => controller.enqueue(event)); controller.close() } }) }
    },
  }
  const refund = createTool({
    id: 'refund', description: 'Simulate an order refund', requireApproval: true,
    inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
    outputSchema: z.object({ refunded: z.boolean() }),
    execute: async () => {
      database.prepare("INSERT INTO effects VALUES ('refund', 1) ON CONFLICT(id) DO UPDATE SET calls = calls + 1").run()
      return { refunded: true }
    },
  })
  const agent = new Agent({
    id: 'customer-agent', name: 'Customer agent', instructions: 'Use the requested tool.', model,
    tools: question ? { askHuman: createPusharyDeferredAskTool(config, { externalId }) } : { refund },
  })
  const storage = new LibSQLStore({ id: 'persistent-demo', url: `file:${join(folder, `${scenario}-mastra.sqlite`)}` })
  new Mastra({ agents: { agent }, storage, logger: false })
  const store = createReviewStore(database)
  try {
    if (phase === 'start') {
      const saved = database.prepare('SELECT decision_id FROM reviews').get()
      assert.ok(!saved || (await store.get(saved.decision_id)).state === 'pending', 'This scenario is already settled or needs recovery. Run answer to inspect it; use a new directory for a new action.')
      let runs = (await agent.listSuspendedRuns()).runs
      if (runs.length === 0) {
        assert.ok(!saved, 'A saved review has no suspended run; inspect the database before proceeding.')
        const output = await agent.generate('Handle this customer request', { maxSteps: 3, memory: { thread: `thread-${scenario}`, resource: externalId } })
        assert.equal(output.finishReason, 'suspended')
        runs = (await agent.listSuspendedRuns()).runs
      }
      assert.equal(runs.length, 1)
      const review = await openPusharyAgentReview(config, {
        agent, agentId: 'customer-agent', runId: runs[0].runId, toolCallId: runs[0].toolCalls[0].toolCallId,
        externalId, actionVersion: 'draft_1', store,
        ...(live ? { requireReachable: true, expiresInSeconds: 3600, question: {
          approve: 'Pushary integration test: approve a simulated refund? No money will move.',
          deny: 'Pushary denial test: please decline this simulated refund. No money will move.',
          select: 'Pushary choice test: select yes. This is a data answer, not permission to refund.',
          input: 'Pushary text test: type yes. This is a data answer, not permission to refund.',
        }[scenario] } : { callbackUrl: 'https://app.invalid/callback' }),
      })
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM effects').get().count, 0)
      assert.equal(review.state, 'pending')
      console.log(`${scenario}: paused before process exit`)
      if (live) console.log('Answer the review in the Pushary app, then run answer with this same directory and scenario. Restarting either process is safe while pending.')
    } else {
      const saved = database.prepare('SELECT decision_id FROM reviews').get()
      assert.ok(saved, 'Run start before answer, using this directory and scenario.')
      const decisionId = saved.decision_id
      let value = scenario === 'deny' ? 'no' : 'yes'
      if (!live) {
        const row = database.prepare('SELECT payload FROM simulated_decisions WHERE id = ?').get(decisionId)
        database.prepare('UPDATE simulated_decisions SET payload = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.payload), status: 'answered', answered: true, value }), decisionId)
      }
      const target = { agent, agentId: 'customer-agent', externalId, decisionId, store, currentActionVersion: async () => 'draft_1' }
      const outcome = await resumePusharyAgentReview(config, target)
      if (outcome.output) database.prepare('INSERT OR IGNORE INTO demo_outputs VALUES (?, ?)').run(decisionId, JSON.stringify({ text: outcome.output.text, toolResults: outcome.output.toolResults }))
      if (live && outcome.status !== 'resumed') {
        const outputSaved = Boolean(database.prepare('SELECT decision_id FROM demo_outputs WHERE decision_id = ?').get(decisionId))
        console.log(JSON.stringify({ status: outcome.status, reason: outcome.reason ?? null, outputSaved }))
        if (!['pending', 'duplicate'].includes(outcome.status) || (outcome.status === 'duplicate' && !outputSaved)) process.exitCode = 1
      } else {
        assert.equal(outcome.status, 'resumed', JSON.stringify(outcome))
        if (live) {
          const decision = await createPusharyServer(config).decisions.get(decisionId)
          value = decision.status === 'answered' ? decision.value : null
        }
        assert.equal(outcome.output.finishReason, 'stop')
        assert.equal(outcome.output.text, 'Finished')
        if (question) {
          const result = outcome.output.toolResults.find((item) => item.payload?.toolName === 'askHuman' || item.toolName === 'askHuman')
          assert.ok(result, 'The question tool returned a result')
          const answer = result.payload?.result ?? result.result ?? result.output
          assert.equal(answer.value, value)
          assert.equal(answer.approved, false)
        }
        const executions = database.prepare("SELECT calls FROM effects WHERE id = 'refund'").get()?.calls ?? 0
        assert.equal(executions, !question && value === 'yes' ? 1 : 0)
        console.log(JSON.stringify({ scenario, answer: value, refundExecutions: executions }))
        assert.equal((await resumePusharyAgentReview(config, target)).status, 'duplicate')
        console.log(`${scenario}: recovered in a fresh process, answered, duplicate ignored`)
      }
    }
  } finally {
    await storage.close()
    database.close()
  }
}
