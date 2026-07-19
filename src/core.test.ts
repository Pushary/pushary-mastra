import { describe, it, expect, afterEach } from 'vitest'
import { createHmac } from 'crypto'
import {
  askExternalUser,
  createDurableDecision,
  resolvePusharyCallback,
  describeAnswer,
  isAffirmative,
  connect,
  type AskResult,
} from './core'

interface Recorded {
  readonly url: string
  readonly method: string
  readonly body: Record<string, unknown> | undefined
}
type Responder = (call: Recorded) => unknown

const realFetch = globalThis.fetch
const installFetch = (responders: readonly Responder[]): Recorded[] => {
  const calls: Recorded[] = []
  let i = 0
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const call: Recorded = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    }
    calls.push(call)
    const json = responders[Math.min(i, responders.length - 1)](call)
    i += 1
    return { ok: true, status: 200, json: async () => json } as Response
  }) as typeof fetch
  return calls
}
afterEach(() => {
  globalThis.fetch = realFetch
})

const CONFIG = { apiKey: 'pk_x.sk_y', baseUrl: 'https://pushary.com/api/v1/server' }
const SECRET = 'whsec_test'
const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('hex')

const ask = (r: Partial<AskResult>): AskResult => ({
  decisionId: 'd',
  status: 'answered',
  answered: true,
  value: 'yes',
  type: 'confirm',
  approved: true,
  ...r,
})

describe('askExternalUser', () => {
  it('creates then polls, keyed by externalId+node+question', async () => {
    const calls = installFetch([
      () => ({ decisionId: 'd1', status: 'pending', answered: false, type: 'confirm' }),
      () => ({ decisionId: 'd1', status: 'answered', answered: true, value: 'yes', type: 'confirm' }),
    ])
    const out = await askExternalUser(CONFIG, { question: 'Approve?', externalId: 'user_1', node: 'ask-human' })
    expect(calls[0].body?.externalId).toBe('user_1')
    expect(calls[0].body?.wait).toBe(false)
    expect(typeof calls[0].body?.idempotencyKey).toBe('string')
    expect(out.approved).toBe(true)
  })
})

describe('createDurableDecision', () => {
  it('opens a non-waiting decision with the callback', async () => {
    const calls = installFetch([() => ({ decisionId: 'd2', status: 'pending', reachable: true })])
    const out = await createDurableDecision(CONFIG, {
      question: 'Approve?',
      externalId: 'user_1',
      node: 'pushary-approval',
      callbackUrl: 'https://app.example.com/cb',
    })
    expect(calls[0].body?.wait).toBe(false)
    expect(calls[0].body?.callbackUrl).toBe('https://app.example.com/cb')
    expect(out.correlationId).toBe('d2')
  })
})

describe('describeAnswer', () => {
  it('formats every outcome', () => {
    expect(describeAnswer('confirm', ask({ approved: true }))).toContain('approved')
    expect(describeAnswer('confirm', ask({ approved: false, value: 'no' }))).toContain('declined')
    expect(describeAnswer('confirm', ask({ answered: false, status: 'expired', approved: false }))).toContain(
      'NOT approved',
    )
    expect(describeAnswer('select', ask({ type: 'select', value: 'B' }))).toContain('B')
  })
})

describe('resolvePusharyCallback', () => {
  it('verifies, parses, folds approved', () => {
    const body = JSON.stringify({ correlationId: 'd1', answer: 'yes', answeredAt: '', context: 'run_1' })
    const out = resolvePusharyCallback(body, sign(body), SECRET)
    expect(out?.approved).toBe(true)
    expect(out?.context).toBe('run_1')
  })
  it('rejects a bad signature', () => {
    const body = JSON.stringify({ correlationId: 'd1', answer: 'yes', answeredAt: '' })
    expect(resolvePusharyCallback(body, 'nope', SECRET)).toBeNull()
  })
})

describe('isAffirmative', () => {
  it('is fail-closed', () => {
    expect(isAffirmative('yes')).toBe(true)
    expect(isAffirmative('no')).toBe(false)
    expect(isAffirmative(null)).toBe(false)
  })
})

describe('connect', () => {
  it('enrolls the end-user', async () => {
    const calls = installFetch([() => ({ externalId: 'user_1', universalLink: 'https://pushary.com/e/tok' })])
    const res = await connect(CONFIG, 'user_1')
    expect(calls[0].url).toBe('https://pushary.com/api/v1/server/enroll')
    expect(res.universalLink).toBe('https://pushary.com/e/tok')
  })
})
