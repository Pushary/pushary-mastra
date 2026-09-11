import { afterEach, expect, expectTypeOf, it, vi } from 'vitest'
import type { Agent } from '@mastra/core/agent'
import type { ApprovableAgent, ResumablePusharyAgent } from './index'
import { Mastra } from '@mastra/core'
import { InMemoryStore } from '@mastra/core/storage'
import { createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { pusharyApprovalStep, pusharyApprovalStepInputSchema, pusharyAnswerSchema } from './index'

afterEach(() => vi.unstubAllGlobals())
it('runs real parallel workflow questions and preserves each response type', async () => {
  const calls: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', async (_url: string, opts: RequestInit) => {
    const body = JSON.parse(String(opts.body))
    calls.push(body)
    return Response.json({ decisionId: body.idempotencyKey, status: 'pending', answered: false, type: body.type })
  })
  const step = pusharyApprovalStep({ apiKey: 'pk_test.sk_test', baseUrl: 'https://example.invalid' }, { callbackUrl: 'https://example.invalid/callback' })
  const workflow = createWorkflow({ id: 'customer-questions', inputSchema: z.array(pusharyApprovalStepInputSchema), outputSchema: z.array(pusharyAnswerSchema) }).foreach(step, { concurrency: 3 }).commit()
  const mastra = new Mastra({ workflows: { workflow }, storage: new InMemoryStore(), logger: false })
  const run = await mastra.getWorkflow('workflow').createRun({ runId: 'run_1' })
  const started = await run.start({ inputData: [
    { operationId: 'approve_1', question: 'Approve?', externalId: 'customer_1', type: 'confirm' },
    { operationId: 'choice_1', question: 'Which one?', externalId: 'customer_1', type: 'select', options: ['yes', 'other'] },
    { operationId: 'note_1', question: 'Add note?', externalId: 'customer_1', type: 'input' },
  ] })
  expect(started.status).toBe('suspended')
  expect(new Set(calls.map((call) => call.idempotencyKey)).size).toBe(3)
  for (const call of calls.slice(0, -1)) await run.resume({ label: String(call.idempotencyKey), resumeData: { answer: 'yes' } })
  const completed = await run.resume({ label: String(calls.at(-1)!.idempotencyKey), resumeData: { answer: 'yes' } })
  expect(completed.status).toBe('success')
  if (completed.status === 'success') {
    expect(completed.result.map((answer) => answer.approved)).toEqual([true, false, false])
    expect(completed.result.map((answer) => answer.value)).toEqual(['yes', 'yes', 'yes'])
  }
  expect(calls).toHaveLength(3)
})

it('accepts the native agent in both approval APIs without a cast', () => {
  expectTypeOf<Agent>().toMatchTypeOf<ApprovableAgent>()
  expectTypeOf<Agent>().toMatchTypeOf<ResumablePusharyAgent>()
})
