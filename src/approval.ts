// The enforced gate. Like `@openai/agents` and unlike eve, Mastra splits approval in
// two: `requireApproval` is a predicate that only decides whether a human is needed,
// and the run then SUSPENDS. Nothing asks anyone. The ask and the resume are the
// caller's job, which is what this module does.
//
// Nothing here imports a type from `@mastra/core`. The shapes below are the parts of
// `AgentRun` and `Agent` this needs, declared with method syntax so a real Agent is
// structurally assignable, and so the `>=1.0.0` peer floor survives Mastra's type churn.

import { createPusharyGate, requirePusharyExternalId, type PusharyMastraConfig } from './core'
import { renderApprovalQuestion } from '@pushary/server/adapters'

/** One suspended tool call inside a suspended run. */
export interface SuspendedToolCall {
  readonly toolCallId?: string
  readonly toolName?: string
  /** Arguments the model supplied. Shown to the approver. */
  readonly args?: unknown
  /** True when the run is waiting on an approval rather than on resume data. */
  readonly requiresApproval: boolean
}

/** One suspended run, as `agent.listSuspendedRuns()` reports it. */
export interface SuspendedAgentRun {
  readonly runId: string
  readonly threadId?: string
  readonly resourceId?: string
  readonly toolCalls: readonly SuspendedToolCall[]
}

/** The part of a Mastra `Agent` this module drives. */
export interface ApprovableAgent {
  listSuspendedRuns(options?: {
    threadId?: string
    resourceId?: string
  }): Promise<{ runs: SuspendedAgentRun[] }>
  approveToolCallGenerate(options: { runId: string; toolCallId?: string }): Promise<unknown>
  declineToolCallGenerate(options: {
    runId: string
    toolCallId?: string
    reason?: string
  }): Promise<unknown>
}

/** One suspended call, as the resolvers see it. */
export interface PendingApproval {
  readonly runId: string
  readonly toolCall: SuspendedToolCall
}

/** Resolves a value from one pending approval. */
export type PendingApprovalResolver<TValue> = (pending: PendingApproval) => TValue

export interface PusharyApprovalConfig extends PusharyMastraConfig {
  /**
   * The enrolled end-user who decides. A string binds every approval to one person;
   * a resolver picks one per call, which is what a multi-tenant product wants.
   */
  readonly externalId: string | PendingApprovalResolver<string | undefined>
  /** Builds the question the human sees. Defaults to the tool name plus its arguments. */
  readonly question?: PendingApprovalResolver<string>
  /** How long the decision stays answerable. */
  readonly expiresInSeconds?: number
  /**
   * Refuse to open a decision nobody can receive, so an end-user with no connected
   * device is denied at request time instead of silently expiring.
   */
  readonly requireReachable?: boolean
}

/** What one suspended call resolved to. */
export interface ResolvedApproval {
  readonly runId: string
  readonly toolName: string
  readonly toolCallId?: string
  readonly approved: boolean
  /** Why it was denied. Absent on an approval. */
  readonly reason?: string
  /**
   * Set when the human answered but Mastra refused the resume. Approving one call
   * resumes the run, so a second call listed against the same run can already be
   * stale by the time its turn comes. The answer is still recorded here rather than
   * thrown away, and the decision's idempotency key means a re-run replays the same
   * answer instead of asking again.
   */
  readonly resumeError?: string
}

export interface ApprovalOutcome {
  readonly resolved: readonly ResolvedApproval[]
  /** True when every pending approval was approved AND its resume went through. */
  readonly allApproved: boolean
}

/**
 * A `requireApproval` predicate that always routes the call to a human.
 *
 * ```ts
 * createTool({ id: 'issue-refund', requireApproval: pusharyRequireApproval(), ... })
 * ```
 *
 * The ask itself happens in {@link resolvePusharyApprovals} after the run suspends.
 */
export const pusharyRequireApproval = (): (() => Promise<boolean>) => async () => true

/**
 * Ask a real person about every tool call a run is suspended on, then approve or
 * decline it. Fails closed: a decline, an expiry, or nobody answering all decline,
 * with the reason handed to the model.
 *
 * ```ts
 * const output = await agent.generate('Refund order 1234', { requireToolApproval: true })
 * if (output.finishReason === 'suspended') {
 *   await resolvePusharyApprovals({ externalId: user.id }, { agent })
 * }
 * ```
 *
 * Pass `runs` to resolve a set you already have; omit it and the agent's suspended
 * runs are listed for you. Only calls with `requiresApproval` are touched, so a tool
 * that suspended for its own resume data is left alone.
 *
 * Each decision is keyed on runId plus toolCallId, so re-running this against the
 * same suspended run resolves to the same decision instead of paging twice.
 */
export const resolvePusharyApprovals = async (
  config: PusharyApprovalConfig,
  target: {
    readonly agent: ApprovableAgent
    readonly runs?: readonly SuspendedAgentRun[]
    /** Passed through to `listSuspendedRuns` when `runs` is omitted. */
    readonly threadId?: string
    readonly resourceId?: string
  },
): Promise<ApprovalOutcome> => {
  const gate = createPusharyGate(config)
  const buildQuestion =
    config.question ??
    ((pending: PendingApproval) =>
      renderApprovalQuestion(pending.toolCall.toolName ?? 'tool', pending.toolCall.args))

  const runs =
    target.runs ??
    (
      await target.agent.listSuspendedRuns({
        ...(target.threadId ? { threadId: target.threadId } : {}),
        ...(target.resourceId ? { resourceId: target.resourceId } : {}),
      })
    ).runs

  const resolved: ResolvedApproval[] = []

  for (const run of runs) {
    for (const toolCall of run.toolCalls) {
      if (!toolCall.requiresApproval) continue

      const pending: PendingApproval = { runId: run.runId, toolCall }
      const toolName = toolCall.toolName ?? 'tool'
      const configured =
        typeof config.externalId === 'function' ? config.externalId(pending) : config.externalId

      const decision = await gate({
        toolName,
        callId: toolCall.toolCallId ?? toolName,
        sessionId: run.runId,
        question: buildQuestion(pending),
        externalId: requirePusharyExternalId(configured),
      })

      const call = toolCall.toolCallId ? { toolCallId: toolCall.toolCallId } : {}
      const base = { runId: run.runId, toolName, toolCallId: toolCall.toolCallId }

      // The human has answered by this point. If Mastra then refuses the resume,
      // record it and keep going rather than throwing away every answer already
      // collected in this batch.
      try {
        if (decision.approved) {
          await target.agent.approveToolCallGenerate({ runId: run.runId, ...call })
        } else {
          await target.agent.declineToolCallGenerate({
            runId: run.runId,
            ...call,
            reason: decision.reason,
          })
        }
        resolved.push(
          decision.approved
            ? { ...base, approved: true }
            : { ...base, approved: false, reason: decision.reason },
        )
      } catch (error) {
        resolved.push({
          ...base,
          approved: false,
          ...(decision.approved ? {} : { reason: decision.reason }),
          resumeError: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  return { resolved, allApproved: resolved.every((item) => item.approved) }
}
