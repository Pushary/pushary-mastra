import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  openPusharyAgentReview,
  resumePusharyAgentReview,
  type PusharyAgentReview,
  type PusharyAgentReviewStore,
  type ResumablePusharyAgent,
} from './deferred'
import type { SuspendedAgentRun } from './approval'
import { answerPusharyQuestion, pusharyQuestionSchema } from './questions'

const config = { apiKey: 'pk_test.sk_test', baseUrl: 'https://pushary.test/api/v1/server' }
afterEach(() => vi.unstubAllGlobals())

const setup = (kind: 'approval' | 'question' = 'approval') => {
  const records = new Map<string, PusharyAgentReview>()
  const decisions = new Map<string, Record<string, unknown>>()
  let runs: SuspendedAgentRun[] = [{
    runId: 'run_1',
    resourceId: 'customer_1',
    toolCalls: [{
      toolCallId: 'call_1', toolName: kind === 'approval' ? 'refund' : 'askHuman',
      requiresApproval: kind === 'approval',
      args: { orderId: 'order_1', amount: 10 },
      suspendPayload: { pushary: 'question', externalId: 'customer_1', request: { question: 'Which item?', type: 'select', options: ['yes', 'other'] } },
    }],
  }]
  const store: PusharyAgentReviewStore = {
    async save(review) { if (!records.has(review.decisionId)) records.set(review.decisionId, review) },
    async get(id) { return records.get(id) ?? null },
    async claim(id, runId) {
      const review = records.get(id)
      if (!review || review.state !== 'pending') return 'settled'
      if ([...records.values()].some((item) => item.runId === runId && ['resuming', 'uncertain'].includes(item.state))) return 'busy'
      records.set(id, { ...review, state: 'resuming' })
      return 'claimed'
    },
    async finish(id, state) { records.set(id, { ...records.get(id)!, state }) },
  }
  const completed = { finishReason: 'stop', text: 'Done' }
  const agent: ResumablePusharyAgent<typeof completed> = {
    listSuspendedRuns: vi.fn(async () => ({ runs })),
    approveToolCallGenerate: vi.fn(async () => { runs = []; return completed }),
    declineToolCallGenerate: vi.fn(async () => { runs = []; return completed }),
    resumeGenerate: vi.fn(async () => { runs = []; return completed }),
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      const previous = [...decisions.values()].find((item) => item.idempotencyKey === body.idempotencyKey)
      const decisionId = previous ? String(previous.decisionId) : `decision_${decisions.size + 1}`
      if (!previous) decisions.set(decisionId, { ...body, decisionId, status: 'pending', answered: false, value: null, options: body.options ?? null })
      return new Response(JSON.stringify(decisions.get(decisionId)))
    }
    return new Response(JSON.stringify(decisions.get(url.split('/').at(-1)!)))
  }))
  const target = {
    agent, agentId: 'agent_1', runId: 'run_1', toolCallId: 'call_1', externalId: 'customer_1', actionVersion: 'draft_1',
    store, callbackUrl: 'https://app.test/callback', subject: { parameters: { amount: 10 } },
  }
  const open = () => openPusharyAgentReview(config, target)
  const resume = (decisionId: string) => resumePusharyAgentReview(config, {
    agent, agentId: 'agent_1', externalId: 'customer_1', decisionId, store,
    currentActionVersion: async () => target.actionVersion,
  })
  const answer = (id: string, value: string) => Object.assign(decisions.get(id)!, { status: 'answered', answered: true, value })
  return { records, decisions, store, agent, open, resume, answer, target, setRuns: (value: SuspendedAgentRun[]) => { runs = value } }
}

describe('deferred agent reviews', () => {
  it('supports polling a saved review without a callback endpoint', async () => {
    const test = setup()
    const { callbackUrl, ...target } = test.target
    const review = await openPusharyAgentReview(config, target)
    expect(test.decisions.get(review.decisionId)?.callbackUrl).toBeUndefined()
    expect(await test.resume(review.decisionId)).toEqual({ status: 'pending' })
    test.answer(review.decisionId, 'yes')
    expect(await test.resume(review.decisionId)).toMatchObject({ status: 'resumed' })
  })

  it('creates a retry-safe binding and leaves a pending approval suspended', async () => {
    const test = setup()
    const review = await test.open()
    expect(await test.open()).toEqual(review)
    expect(test.decisions.size).toBe(1)
    expect(test.decisions.get(review.decisionId)).toMatchObject({ wait: false, parameters: { amount: 10 }, callbackUrl: test.target.callbackUrl })
    expect(await test.resume(review.decisionId)).toEqual({ status: 'pending' })
    expect(test.agent.approveToolCallGenerate).not.toHaveBeenCalled()
  })

  it('resumes once on a late answer and returns the resulting generation', async () => {
    const test = setup()
    const review = await test.open()
    test.answer(review.decisionId, 'yes')
    const outcomes = await Promise.all([test.resume(review.decisionId), test.resume(review.decisionId)])
    expect(outcomes.filter((item) => item.status === 'resumed')).toHaveLength(1)
    expect(test.agent.approveToolCallGenerate).toHaveBeenCalledTimes(1)
    expect(outcomes.find((item) => item.status === 'resumed')).toMatchObject({ output: { text: 'Done' }, pending: [] })
    expect(await test.resume(review.decisionId)).toEqual({ status: 'duplicate' })
  })

  it('preserves opaque customer and action identities without trimming', async () => {
    const test = setup()
    test.target.externalId = ' customer_1 '
    test.target.actionVersion = ' draft_1 '
    test.target.agentId = ' agent_1 '
    const review = await test.open()
    expect(review).toMatchObject({ externalId: ' customer_1 ', actionVersion: ' draft_1 ', agentId: ' agent_1 ' })
    expect(test.decisions.get(review.decisionId)?.externalId).toBe(' customer_1 ')
  })

  it.each(['x'.repeat(257), '😀'.repeat(129)])('rejects a recipient exceeding 256 UTF-16 units before HTTP', async (externalId) => {
    const test = setup()
    test.target.externalId = externalId
    await expect(test.open()).rejects.toThrow()
    expect(test.decisions.size).toBe(0)
  })

  it('returns unknown for an early callback so a durable inbox can retry', async () => {
    expect(await setup().resume('decision_early')).toEqual({ status: 'unknown' })
  })

  it('rejects a response belonging to a different customer', async () => {
    const test = setup()
    const review = await test.open()
    Object.assign(test.decisions.get(review.decisionId)!, { externalId: 'other_customer' })
    await expect(test.resume(review.decisionId)).rejects.toThrow('binding')
    expect(test.agent.approveToolCallGenerate).not.toHaveBeenCalled()
  })

  it('accepts the API cache response with null recipient only through the exact saved context', async () => {
    const test = setup()
    const review = await test.open()
    test.answer(review.decisionId, 'yes')
    Object.assign(test.decisions.get(review.decisionId)!, { externalId: null })
    expect(await test.resume(review.decisionId)).toMatchObject({ status: 'resumed' })
  })

  it('rejects changed question text and select options from the authoritative decision', async () => {
    for (const changed of [{ question: 'A different question' }, { options: ['yes', 'new'] }]) {
      const test = setup('question')
      const review = await test.open()
      test.answer(review.decisionId, 'yes')
      Object.assign(test.decisions.get(review.decisionId)!, changed)
      await expect(test.resume(review.decisionId)).rejects.toThrow('binding')
      expect(test.agent.resumeGenerate).not.toHaveBeenCalled()
    }
  })

  it('rejects an oversized binding before creating a decision', async () => {
    const test = setup()
    test.target.actionVersion = 'x'.repeat(2000)
    await expect(test.open()).rejects.toThrow('context limit')
    expect(test.decisions.size).toBe(0)
  })

  it('refuses changed action versions and changed native tool arguments', async () => {
    const test = setup()
    const review = await test.open()
    test.answer(review.decisionId, 'yes')
    test.target.actionVersion = 'draft_2'
    expect(await test.resume(review.decisionId)).toEqual({ status: 'stale' })
    expect(test.agent.approveToolCallGenerate).not.toHaveBeenCalled()
    const changed = setup()
    const next = await changed.open()
    changed.answer(next.decisionId, 'yes')
    changed.setRuns([{ runId: 'run_1', resourceId: 'customer_1', toolCalls: [{ toolCallId: 'call_1', toolName: 'refund', requiresApproval: true, args: { amount: 999 } }] }])
    expect(await changed.resume(next.decisionId)).toEqual({ status: 'stale' })
  })

  it('changes identity when trusted presentation facts change', async () => {
    const test = setup()
    const first = await test.open()
    test.target.subject.parameters.amount = 11
    expect((await test.open()).decisionId).not.toBe(first.decisionId)
  })

  it('declines denied and expired approvals instead of executing the action', async () => {
    for (const status of ['answered', 'expired'] as const) {
      const test = setup()
      const review = await test.open()
      Object.assign(test.decisions.get(review.decisionId)!, { status, value: status === 'answered' ? 'no' : null })
      expect(await test.resume(review.decisionId)).toMatchObject({ status: 'resumed' })
      expect(test.agent.declineToolCallGenerate).toHaveBeenCalledTimes(1)
      expect(test.agent.approveToolCallGenerate).not.toHaveBeenCalled()
    }
  })

  it('resumes select as question data, never as approval even when the answer is yes', async () => {
    const test = setup('question')
    const review = await test.open()
    test.answer(review.decisionId, 'yes')
    expect(await test.resume(review.decisionId)).toMatchObject({ status: 'resumed' })
    expect(test.agent.resumeGenerate).toHaveBeenCalledWith({ decisionId: review.decisionId }, { runId: 'run_1', toolCallId: 'call_1' })
    expect(test.agent.approveToolCallGenerate).not.toHaveBeenCalled()
    expect(answerPusharyQuestion(review.question, 'answered', 'yes')).toEqual({ status: 'answered', value: 'yes', approved: false })
  })

  it('retains an uncertain state after a resume error and never retries it automatically', async () => {
    const test = setup()
    const review = await test.open()
    test.answer(review.decisionId, 'yes')
    vi.mocked(test.agent.approveToolCallGenerate).mockRejectedValue(new Error('connection lost after resume'))
    expect(await test.resume(review.decisionId)).toMatchObject({ status: 'uncertain' })
    expect(await test.resume(review.decisionId)).toEqual({ status: 'uncertain' })
    expect(test.agent.approveToolCallGenerate).toHaveBeenCalledTimes(1)
  })

  it('returns the generation even when completed and uncertain state writes fail', async () => {
    const test = setup()
    const review = await test.open()
    test.answer(review.decisionId, 'yes')
    test.store.finish = vi.fn(async () => { throw new Error('database unavailable') })
    expect(await test.resume(review.decisionId)).toMatchObject({
      status: 'uncertain', output: { text: 'Done' }, persistenceError: 'database unavailable',
    })
    expect(test.records.get(review.decisionId)?.state).toBe('resuming')
    expect(await test.resume(review.decisionId)).toEqual({ status: 'busy' })
    expect(test.agent.approveToolCallGenerate).toHaveBeenCalledTimes(1)
  })

  it('rejects a tampered context before claiming or resuming', async () => {
    const test = setup()
    const review = await test.open()
    test.answer(review.decisionId, 'yes')
    Object.assign(test.decisions.get(review.decisionId)!, { context: '{}', externalId: null })
    await expect(test.resume(review.decisionId)).rejects.toThrow('binding')
    expect(test.records.get(review.decisionId)?.state).toBe('pending')
    expect(test.agent.approveToolCallGenerate).not.toHaveBeenCalled()
  })

  it('returns new suspensions without replaying the original batch', async () => {
    const test = setup()
    const review = await test.open()
    test.answer(review.decisionId, 'yes')
    vi.mocked(test.agent.approveToolCallGenerate).mockImplementation(async () => {
      test.setRuns([{ runId: 'run_1', resourceId: 'customer_1', toolCalls: [{ toolCallId: 'call_2', toolName: 'send', requiresApproval: true }] }])
      return { finishReason: 'suspended', text: '' }
    })
    expect(await test.resume(review.decisionId)).toMatchObject({ status: 'resumed', pending: [{ toolCalls: [{ toolCallId: 'call_2' }] }] })
  })
})

it('validates question options and preserves free text without treating it as approval', () => {
  expect(pusharyQuestionSchema.safeParse({ question: 'Choose', type: 'select' }).success).toBe(false)
  expect(pusharyQuestionSchema.safeParse({ question: 'Choose', type: 'select', options: ['a', 'a'] }).success).toBe(false)
  expect(answerPusharyQuestion({ question: 'Note', type: 'input' }, 'answered', 'yes')).toEqual({ status: 'answered', value: 'yes', approved: false })
  expect(() => answerPusharyQuestion({ question: 'Choose', type: 'select', options: ['a'] }, 'answered', 'b')).toThrow('configured option')
})
