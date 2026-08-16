import { describe, it, expect, afterEach } from 'vitest'
import {
  pusharyRequireApproval,
  resolvePusharyApprovals,
  type ApprovableAgent,
  type SuspendedAgentRun,
} from './approval'

interface Recorded {
  readonly body: Record<string, unknown> | undefined
}
type Responder = () => unknown

const realFetch = globalThis.fetch
const installFetch = (responders: readonly Responder[]): Recorded[] => {
  const calls: Recorded[] = []
  let i = 0
  globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
    calls.push({ body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined })
    const json = responders[Math.min(i, responders.length - 1)]()
    i += 1
    return { ok: true, status: 200, json: async () => json } as Response
  }) as typeof fetch
  return calls
}
afterEach(() => {
  globalThis.fetch = realFetch
})

const CONFIG = {
  apiKey: 'pk_x.sk_y',
  baseUrl: 'https://pushary.com/api/v1/server',
  timeoutMs: 0,
  externalId: 'user_1',
}

const answered = (value: string) => () => ({
  decisionId: 'd1',
  status: 'answered',
  answered: true,
  value,
  type: 'confirm',
})
const unanswered = () => ({
  decisionId: 'd1',
  status: 'pending',
  answered: false,
  value: null,
  type: 'confirm',
})

const suspendedRun = (over: Partial<SuspendedAgentRun> = {}): SuspendedAgentRun => ({
  runId: 'run_1',
  toolCalls: [
    {
      toolCallId: 'tc_1',
      toolName: 'issue-refund',
      args: { amount: 480 },
      requiresApproval: true,
    },
  ],
  ...over,
})

interface FakeAgent extends ApprovableAgent {
  readonly approvals: { runId: string; toolCallId?: string }[]
  readonly declines: { runId: string; toolCallId?: string; reason?: string }[]
  readonly listedWith: unknown[]
}
const fakeAgent = (runs: readonly SuspendedAgentRun[]): FakeAgent => {
  const approvals: { runId: string; toolCallId?: string }[] = []
  const declines: { runId: string; toolCallId?: string; reason?: string }[] = []
  const listedWith: unknown[] = []
  return {
    approvals,
    declines,
    listedWith,
    listSuspendedRuns: async (options) => {
      listedWith.push(options)
      return { runs: [...runs] }
    },
    approveToolCallGenerate: async (options) => void approvals.push(options),
    declineToolCallGenerate: async (options) => void declines.push(options),
  }
}

describe('pusharyRequireApproval', () => {
  it('routes every call to a human', async () => {
    expect(await pusharyRequireApproval()()).toBe(true)
  })
})

describe('resolvePusharyApprovals', () => {
  it('approves the suspended call when the human says yes', async () => {
    installFetch([answered('yes')])
    const agent = fakeAgent([suspendedRun()])
    const outcome = await resolvePusharyApprovals(CONFIG, { agent })
    expect(agent.approvals).toEqual([{ runId: 'run_1', toolCallId: 'tc_1' }])
    expect(agent.declines).toHaveLength(0)
    expect(outcome.allApproved).toBe(true)
  })

  it('declines with the reason when the human says no', async () => {
    installFetch([answered('no')])
    const agent = fakeAgent([suspendedRun()])
    const outcome = await resolvePusharyApprovals(CONFIG, { agent })
    expect(agent.approvals).toHaveLength(0)
    expect(agent.declines[0]?.reason).toContain('denied')
    expect(outcome.allApproved).toBe(false)
  })

  it('fails closed when nobody answers', async () => {
    installFetch([unanswered])
    const agent = fakeAgent([suspendedRun()])
    const outcome = await resolvePusharyApprovals(CONFIG, { agent })
    expect(agent.declines).toHaveLength(1)
    expect(outcome.resolved[0]?.reason).toContain('No answer')
  })

  it('leaves alone a tool that suspended for its own resume data', async () => {
    const calls = installFetch([answered('yes')])
    const agent = fakeAgent([
      suspendedRun({
        toolCalls: [{ toolCallId: 'tc_9', toolName: 'wait-for-doc', requiresApproval: false }],
      }),
    ])
    const outcome = await resolvePusharyApprovals(CONFIG, { agent })
    expect(calls).toHaveLength(0)
    expect(agent.approvals).toHaveLength(0)
    expect(agent.declines).toHaveLength(0)
    expect(outcome.resolved).toHaveLength(0)
  })

  it('keys the decision on runId and toolCallId so a re-run does not ask twice', async () => {
    const calls = installFetch([answered('yes'), answered('yes')])
    await resolvePusharyApprovals(CONFIG, { agent: fakeAgent([suspendedRun()]) })
    await resolvePusharyApprovals(CONFIG, { agent: fakeAgent([suspendedRun()]) })
    expect(calls[0]?.body?.idempotencyKey).toBe(calls[1]?.body?.idempotencyKey)
  })

  it('keys two runs of the same tool apart', async () => {
    const calls = installFetch([answered('yes'), answered('yes')])
    await resolvePusharyApprovals(CONFIG, {
      agent: fakeAgent([suspendedRun(), suspendedRun({ runId: 'run_2' })]),
    })
    expect(calls[0]?.body?.idempotencyKey).not.toBe(calls[1]?.body?.idempotencyKey)
  })

  it('puts the tool arguments in the question', async () => {
    const calls = installFetch([answered('yes')])
    await resolvePusharyApprovals(CONFIG, { agent: fakeAgent([suspendedRun()]) })
    expect(String(calls[0]?.body?.question)).toContain('480')
  })

  it('lets externalId be resolved per call for a multi-tenant product', async () => {
    const calls = installFetch([answered('yes')])
    await resolvePusharyApprovals(
      { ...CONFIG, externalId: (pending) => `tenant:${pending.runId}` },
      { agent: fakeAgent([suspendedRun()]) },
    )
    expect(calls[0]?.body?.externalId).toBe('tenant:run_1')
  })

  it('resolves a set of runs handed in directly without listing', async () => {
    installFetch([answered('yes')])
    const agent = fakeAgent([])
    await resolvePusharyApprovals(CONFIG, { agent, runs: [suspendedRun()] })
    expect(agent.listedWith).toHaveLength(0)
    expect(agent.approvals).toHaveLength(1)
  })

  it('keeps the answers it already has when Mastra refuses a resume', async () => {
    installFetch([answered('yes'), answered('yes')])
    const agent = fakeAgent([
      suspendedRun({
        toolCalls: [
          { toolCallId: 'tc_1', toolName: 'issue-refund', requiresApproval: true },
          { toolCallId: 'tc_2', toolName: 'send-email', requiresApproval: true },
        ],
      }),
    ])
    // Approving the first call resumes the run, so the second id can be stale.
    const realApprove = agent.approveToolCallGenerate
    let calls = 0
    ;(agent as { approveToolCallGenerate: ApprovableAgent['approveToolCallGenerate'] }).approveToolCallGenerate =
      async (options) => {
        calls += 1
        if (calls === 2) throw new Error('run is no longer suspended')
        return realApprove(options)
      }

    const outcome = await resolvePusharyApprovals(CONFIG, { agent })

    expect(outcome.resolved).toHaveLength(2)
    expect(outcome.resolved[0]).toMatchObject({ toolCallId: 'tc_1', approved: true })
    expect(outcome.resolved[1]?.resumeError).toContain('no longer suspended')
    expect(outcome.allApproved).toBe(false)
  })

  it('scopes the listing to a thread when asked', async () => {
    installFetch([answered('yes')])
    const agent = fakeAgent([suspendedRun()])
    await resolvePusharyApprovals(CONFIG, { agent, threadId: 'thread_7' })
    expect(agent.listedWith[0]).toEqual({ threadId: 'thread_7' })
  })
})
