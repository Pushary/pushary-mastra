import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  pusharyRequireApproval,
  resolvePusharyApprovals,
  type ApprovableAgent,
  type SuspendedAgentRun,
  type PusharyApprovalConfig,
} from './approval'

interface Recorded {
  readonly body: Record<string, unknown> | undefined
}
type Responder = () => unknown

// What POST /authorize answers. The gate asks policy before it asks a person; this
// suite is about the framework binding, so the default verdict is the one that
// still reaches a human.
const REQUIRES_HUMAN = {
  verdict: 'requires_human',
  policy: null,
  reason: 'No policy rule names this action, so a person decides.',
  authorizationId: null,
}

const realFetch = globalThis.fetch
// The policy hop is answered but not recorded, so `calls` keeps meaning "the
// decisions this adapter opened" and every assertion below reads as it did before
// the gate consulted policy.
const installFetch = (
  responders: readonly Responder[],
  evaluation: unknown = REQUIRES_HUMAN,
): Recorded[] => {
  const calls: Recorded[] = []
  let i = 0
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    if (String(input).endsWith('/authorize')) {
      return { ok: true, status: 200, json: async () => evaluation } as Response
    }
    calls.push({ body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined })
    const json = responders[Math.min(i, responders.length - 1)]()
    i += 1
    return { ok: true, status: 200, json: async () => json } as Response
  }) as typeof fetch
  return calls
}

const ALLOWED = {
  verdict: 'allow',
  policy: 'issue_refund',
  reason: 'Allowed by policy rule issue_refund.',
  authorizationId: 'az_1',
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
  it('marks each tool call as requiring Mastra approval', async () => {
    expect(await pusharyRequireApproval()()).toBe(true)
  })
})

describe('resolvePusharyApprovals', () => {
  it('approves the suspended call when the human says yes', async () => {
    installFetch([answered('yes')])
    const agent = fakeAgent([suspendedRun()])
    const outcome = await resolvePusharyApprovals(CONFIG, { agent, resourceId: 'customer_1' })
    expect(agent.approvals).toEqual([{ runId: 'run_1', toolCallId: 'tc_1' }])
    expect(agent.declines).toHaveLength(0)
    expect(outcome.allApproved).toBe(true)
  })

  it('approves the suspended call without opening a decision when a rule allows it', async () => {
    const calls = installFetch([answered('yes')], ALLOWED)
    const agent = fakeAgent([suspendedRun()])
    const outcome = await resolvePusharyApprovals(CONFIG, { agent, resourceId: 'customer_1' })
    expect(agent.approvals).toEqual([{ runId: 'run_1', toolCallId: 'tc_1' }])
    expect(outcome.allApproved).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('declines with the reason when the human says no', async () => {
    installFetch([answered('no')])
    const agent = fakeAgent([suspendedRun()])
    const outcome = await resolvePusharyApprovals(CONFIG, { agent, resourceId: 'customer_1' })
    expect(agent.approvals).toHaveLength(0)
    expect(agent.declines[0]?.reason).toContain('denied')
    expect(outcome.allApproved).toBe(false)
  })

  it('fails closed when nobody answers', async () => {
    installFetch([unanswered])
    const agent = fakeAgent([suspendedRun()])
    const outcome = await resolvePusharyApprovals(CONFIG, { agent, resourceId: 'customer_1' })
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
    const outcome = await resolvePusharyApprovals(CONFIG, { agent, resourceId: 'customer_1' })
    expect(calls).toHaveLength(0)
    expect(agent.approvals).toHaveLength(0)
    expect(agent.declines).toHaveLength(0)
    expect(outcome.resolved).toHaveLength(0)
  })

  it('keys the decision on runId and toolCallId so a re-run does not ask twice', async () => {
    const calls = installFetch([answered('yes'), answered('yes')])
    await resolvePusharyApprovals(CONFIG, { resourceId: 'customer_1', agent: fakeAgent([suspendedRun()]) })
    await resolvePusharyApprovals(CONFIG, { resourceId: 'customer_1', agent: fakeAgent([suspendedRun()]) })
    expect(calls[0]?.body?.idempotencyKey).toBe(calls[1]?.body?.idempotencyKey)
  })

  it('keys two runs of the same tool apart', async () => {
    const calls = installFetch([answered('yes'), answered('yes')])
    await resolvePusharyApprovals(CONFIG, {
      resourceId: 'customer_1',
      agent: fakeAgent([suspendedRun(), suspendedRun({ runId: 'run_2' })]),
    })
    expect(calls[0]?.body?.idempotencyKey).not.toBe(calls[1]?.body?.idempotencyKey)
  })

  it('puts the tool arguments in the question', async () => {
    const calls = installFetch([answered('yes')])
    await resolvePusharyApprovals(CONFIG, { resourceId: 'customer_1', agent: fakeAgent([suspendedRun()]) })
    expect(String(calls[0]?.body?.question)).toContain('480')
  })

  it('lets externalId be resolved per call for a multi-tenant product', async () => {
    const calls = installFetch([answered('yes')])
    await resolvePusharyApprovals(
      { ...CONFIG, externalId: (pending) => `tenant:${pending.runId}` },
      { resourceId: 'customer_1', agent: fakeAgent([suspendedRun()]) },
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
        await realApprove(options)
        return { finishReason: 'suspended' }
      }

    const outcome = await resolvePusharyApprovals(CONFIG, { agent, resourceId: 'customer_1' })

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


it('requires a trusted run scope instead of listing every customer', async () => {
  await expect(resolvePusharyApprovals(CONFIG, { agent: fakeAgent([]) })).rejects.toThrow('trusted runs')
})

it('honors explicit human-required policy and forwards structured arguments', async () => {
  const calls = installFetch([answered('yes')], ALLOWED)
  await resolvePusharyApprovals({ ...CONFIG, policy: false, subject: () => ({ toolTarget: 'order_1' }) }, {
    agent: fakeAgent([]), runs: [suspendedRun()],
  })
  expect(calls).toHaveLength(1)
  expect(calls[0].body).toMatchObject({ parameters: { amount: 480 }, toolTarget: 'order_1' })
})

it('preserves a suspended generation and returns the next review at the configured limit', async () => {
  installFetch([answered('yes')])
  const next = suspendedRun({ toolCalls: [{ toolCallId: 'tc_2', toolName: 'send-email', requiresApproval: true }] })
  const output = { finishReason: 'suspended', text: 'Need another approval' }
  const agent: ApprovableAgent<typeof output> = {
    listSuspendedRuns: async () => ({ runs: [next] }),
    approveToolCallGenerate: async () => output,
    declineToolCallGenerate: async () => output,
  }
  const outcome = await resolvePusharyApprovals({ ...CONFIG, maxApprovals: 1 }, { agent, runs: [suspendedRun()] })
  expect(outcome.resolved[0].output).toBe(output)
  expect(outcome.pending).toEqual([next])
  expect(outcome.allApproved).toBe(false)
})

it('retains the generated output when snapshot rediscovery fails', async () => {
  installFetch([answered('yes')])
  const output = { finishReason: 'suspended', text: 'Awaiting next input' }
  const agent: ApprovableAgent<typeof output> = {
    listSuspendedRuns: async () => { throw new Error('storage unavailable') },
    approveToolCallGenerate: async () => output,
    declineToolCallGenerate: async () => output,
  }
  const result = await resolvePusharyApprovals(CONFIG, { agent, runs: [suspendedRun()] })
  expect(result.resolved).toHaveLength(1)
  expect(result.resolved[0]).toMatchObject({ output, discoveryError: 'storage unavailable' })
  expect(result.allApproved).toBe(false)
})

it.each(['http400', 'http503', 'customer', 'subject', 'question', 'identity'] as const)(
  'retains an earlier generation when the next review fails during %s',
  async (failure) => {
    installFetch([answered('yes')])
    const approvedFetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      requests += 1
      if (failure.startsWith('http') && requests > 1) return Response.json({ error: 'Review request rejected' }, { status: failure === 'http400' ? 400 : 503 })
      return approvedFetch(...args)
    }) as typeof fetch
    const output = { finishReason: 'stop', text: 'The first action completed' }
    const resume = vi.fn(async () => output)
    const agent: ApprovableAgent<typeof output> = {
      listSuspendedRuns: async () => ({ runs: [] }),
      approveToolCallGenerate: resume,
      declineToolCallGenerate: vi.fn(async () => output),
    }
    const later = suspendedRun({
      runId: 'run_2',
      toolCalls: [{ toolCallId: failure === 'identity' ? undefined : 'tc_2', toolName: 'send-email', requiresApproval: true }],
    })
    const config: PusharyApprovalConfig = {
      ...CONFIG,
      policy: false,
      externalId: ({ runId }) => failure === 'customer' && runId === 'run_2' ? undefined : 'user_1',
      subject: ({ runId }) => {
        if (failure === 'subject' && runId === 'run_2') throw new Error('Subject could not be prepared')
        return {}
      },
      question: ({ runId }) => {
        if (failure === 'question' && runId === 'run_2') throw new Error('Question could not be prepared')
        return 'Approve this action?'
      },
    }
    const outcome = await resolvePusharyApprovals(config, { agent, runs: [suspendedRun(), later] })
    expect(outcome.resolved).toHaveLength(2)
    expect(outcome.resolved[0]).toMatchObject({ approved: true, output })
    expect(outcome.resolved[1]).toMatchObject({ runId: 'run_2', approved: false, reviewError: expect.any(String) })
    expect(outcome.resolved[1].resumeError).toBeUndefined()
    expect(outcome.resolved[1].output).toBeUndefined()
    expect(outcome.pending).toEqual([later])
    expect(outcome.allApproved).toBe(false)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(agent.declineToolCallGenerate).not.toHaveBeenCalled()
  },
)
