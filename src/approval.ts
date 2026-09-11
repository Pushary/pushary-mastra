import { z } from 'zod'
import { renderApprovalQuestion, type ApprovalAsk, type PusharyGateConfig } from '@pushary/server/adapters'
import { createPusharyGate, requirePusharyExternalId } from './core'

export interface SuspendedToolCall {
  readonly toolCallId?: string
  readonly toolName?: string
  readonly args?: unknown
  readonly requiresApproval: boolean
  readonly suspendPayload?: unknown
}

export interface SuspendedAgentRun {
  readonly runId: string
  readonly threadId?: string
  readonly resourceId?: string
  readonly toolCalls: readonly SuspendedToolCall[]
}

export interface ApprovableAgent<TOutput = unknown> {
  listSuspendedRuns(options?: {
    threadId?: string
    resourceId?: string
  }): Promise<{ runs: SuspendedAgentRun[] }>
  approveToolCallGenerate(options: { runId: string; toolCallId?: string }): Promise<TOutput>
  declineToolCallGenerate(options: {
    runId: string
    toolCallId?: string
    reason?: string
  }): Promise<TOutput>
}

export interface PendingApproval {
  readonly runId: string
  readonly threadId?: string
  readonly resourceId?: string
  readonly toolCall: SuspendedToolCall
}

export type PendingApprovalResolver<TValue> = (pending: PendingApproval) => TValue
export type PusharyApprovalSubject = Pick<ApprovalAsk, 'parameters' | 'toolTarget' | 'actor' | 'environment' | 'presentation' | 'context'>

export interface PusharyApprovalConfig extends PusharyGateConfig {
  readonly externalId: string | PendingApprovalResolver<string | undefined>
  readonly question?: PendingApprovalResolver<string>
  readonly subject?: PendingApprovalResolver<PusharyApprovalSubject>
  readonly maxApprovals?: number
}

export interface ResolvedApproval<TOutput = unknown> {
  readonly runId: string
  readonly toolName?: string
  readonly toolCallId?: string
  readonly approved: boolean
  readonly reason?: string
  readonly output?: TOutput
  readonly reviewError?: string
  readonly resumeError?: string
  readonly discoveryError?: string
}

export interface ApprovalOutcome<TOutput = unknown> {
  readonly resolved: readonly ResolvedApproval<TOutput>[]
  readonly pending: readonly SuspendedAgentRun[]
  readonly allApproved: boolean
}

const suspendedOutput = z.object({ finishReason: z.literal('suspended') })
const approvalLimit = z.number().int().min(1).max(100)

export const pusharyRequireApproval = (): (() => Promise<boolean>) => async () => true

export const resolvePusharyApprovals = async <TOutput>(
  config: PusharyApprovalConfig,
  target: {
    readonly agent: ApprovableAgent<TOutput>
    readonly runs?: readonly SuspendedAgentRun[]
    readonly threadId?: string
    readonly resourceId?: string
  },
): Promise<ApprovalOutcome<TOutput>> => {
  if (!target.runs && !target.threadId && !target.resourceId) {
    throw new Error('Pushary: provide trusted runs or a customer-scoped threadId/resourceId.')
  }
  const limit = approvalLimit.parse(config.maxApprovals ?? 10)
  const gate = createPusharyGate(config)
  const scope = {
    ...(target.threadId ? { threadId: target.threadId } : {}),
    ...(target.resourceId ? { resourceId: target.resourceId } : {}),
  }
  const runs = target.runs ?? (await target.agent.listSuspendedRuns(scope)).runs
  const resolved: ResolvedApproval<TOutput>[] = []
  const pending: SuspendedAgentRun[] = []

  for (const initialRun of runs) {
    let current: SuspendedAgentRun | undefined = initialRun
    const seen = new Set<string>()
    while (current) {
      const activeRun: SuspendedAgentRun = current
      const toolCall = current.toolCalls.find((call) => call.requiresApproval && !seen.has(call.toolCallId ?? ''))
      if (!toolCall || resolved.length >= limit) {
        pending.push(current)
        break
      }
      let prepared: { decision: Awaited<ReturnType<typeof gate>>; toolCallId: string; toolName: string }
      try {
        if (!toolCall.toolCallId || !toolCall.toolName) {
          throw new Error('Pushary: suspended approvals require a toolCallId and toolName.')
        }
        seen.add(toolCall.toolCallId)
        const review: PendingApproval = { ...current, toolCall }
        const externalId = requirePusharyExternalId(
          typeof config.externalId === 'function' ? config.externalId(review) : config.externalId,
        )
        const decision = await gate({
          ...config.subject?.(review),
          toolName: toolCall.toolName,
          input: toolCall.args,
          callId: toolCall.toolCallId,
          sessionId: current.runId,
          question: config.question?.(review) ?? renderApprovalQuestion(toolCall.toolName, toolCall.args),
          externalId,
        })
        prepared = { decision, toolCallId: toolCall.toolCallId, toolName: toolCall.toolName }
      } catch (error) {
        resolved.push({
          runId: activeRun.runId,
          toolName: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
          approved: false,
          reviewError: error instanceof Error ? error.message : String(error),
        })
        pending.push(activeRun)
        break
      }
      const { decision, toolCallId, toolName } = prepared
      const call = { runId: activeRun.runId, toolCallId }
      const base = { ...call, toolName }
      try {
        const output: TOutput = decision.approved
          ? await target.agent.approveToolCallGenerate(call)
          : await target.agent.declineToolCallGenerate({ ...call, reason: decision.reason })
        resolved.push({
          ...base,
          approved: decision.approved,
          ...(!decision.approved ? { reason: decision.reason } : {}),
          output,
        })
        if (suspendedOutput.safeParse(output).success) {
          try {
            current = (await target.agent.listSuspendedRuns(scope)).runs.find((run) => run.runId === initialRun.runId)
            if (!current) throw new Error('Mastra returned a suspension but its snapshot is not discoverable.')
          } catch (error) {
            resolved[resolved.length - 1] = { ...resolved[resolved.length - 1], discoveryError: error instanceof Error ? error.message : String(error) }
            current = undefined
          }
        } else current = undefined
      } catch (error) {
        resolved.push({
          ...base,
          approved: false,
          ...(!decision.approved ? { reason: decision.reason } : {}),
          resumeError: error instanceof Error ? error.message : String(error),
        })
        pending.push(activeRun)
        break
      }
    }
  }
  return { resolved, pending, allApproved: pending.length === 0 && resolved.every((item) => item.approved && !item.discoveryError) }
}
