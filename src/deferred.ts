import { createTool } from '@mastra/core/tools'
import { createPusharyServer, type CreateDecision } from '@pushary/server'
import { z } from 'zod'
import { createDurableDecision, deterministicKey, type PusharyMastraConfig } from './core'
import { deriveParameters, renderApprovalQuestion } from '@pushary/server/adapters'
import type { ApprovableAgent, SuspendedAgentRun, SuspendedToolCall } from './approval'
import {
  answerPusharyQuestion,
  fingerprintPusharyAction,
  pusharyAnswerSchema,
  pusharyQuestionSchema,
  type PusharyQuestion,
} from './questions'

const id = z.string().refine((value) => value.trim().length > 0, 'Pushary: an identifier cannot be blank.')
const externalIdSchema = id.refine((value) => value.length <= 256, 'Pushary: externalId must be at most 256 UTF-16 code units.')
const suspendedOutput = z.object({ finishReason: z.literal('suspended') })
const reviewBindingSchema = z.object({
  version: z.literal(1),
  agentId: id,
  runId: id,
  toolCallId: id,
  toolName: id,
  externalId: externalIdSchema,
  actionVersion: id,
  inputHash: id,
  subjectHash: id,
  kind: z.enum(['approval', 'question']),
  question: pusharyQuestionSchema,
  threadId: id.optional(),
  resourceId: id.optional(),
})

const reviewContextSchema = reviewBindingSchema.omit({ question: true }).extend({ questionHash: id })
const contextSchema = z.string().max(2000, 'Pushary: review binding exceeds the decision context limit.')

export const pusharyAgentReviewSchema = reviewBindingSchema.extend({
  decisionId: id,
  correlationId: id,
  state: z.enum(['pending', 'resuming', 'completed', 'stale', 'uncertain']),
})

export type PusharyAgentReview = z.infer<typeof pusharyAgentReviewSchema>
export type PusharyAgentReviewBinding = z.infer<typeof reviewBindingSchema>

export interface PusharyAgentReviewStore {
  save(review: PusharyAgentReview): Promise<void>
  get(decisionId: string): Promise<PusharyAgentReview | null>
  claim(decisionId: string, runId: string): Promise<'claimed' | 'busy' | 'settled'>
  finish(decisionId: string, state: 'completed' | 'stale' | 'uncertain', reason?: string): Promise<void>
}

export interface ResumablePusharyAgent<TOutput = unknown> extends ApprovableAgent<TOutput> {
  resumeGenerate(data: { decisionId: string }, options: { runId: string; toolCallId: string }): Promise<TOutput>
}

const questionSuspensionSchema = z.object({
  pushary: z.literal('question'),
  externalId: externalIdSchema,
  request: pusharyQuestionSchema,
})

const decisionSchema = z.object({
  decisionId: id,
  status: z.enum(['pending', 'answered', 'expired', 'cancelled']),
  type: z.enum(['confirm', 'select', 'input']),
  value: z.string().nullable(),
  externalId: externalIdSchema.nullable(),
  question: z.string(),
  options: z.array(z.string()).nullable(),
  context: contextSchema,
})

const client = (config: PusharyMastraConfig) => createPusharyServer({
  apiKey: config.apiKey ?? process.env.PUSHARY_API_KEY ?? '',
  ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
})
const bindingContext = (binding: PusharyAgentReviewBinding): string => {
  const { question, ...identity } = reviewBindingSchema.parse(binding)
  return contextSchema.parse(JSON.stringify({ ...identity, questionHash: fingerprintPusharyAction(question) }))
}
const toolInput = (call: SuspendedToolCall): unknown => call.requiresApproval
  ? call.args ?? null
  : questionSuspensionSchema.parse(call.suspendPayload).request

const sameCall = (review: PusharyAgentReview, run: SuspendedAgentRun | undefined): boolean => {
  const call = run?.toolCalls.find((item) => item.toolCallId === review.toolCallId)
  if (!call || call.toolName !== review.toolName || call.requiresApproval !== (review.kind === 'approval')) return false
  if (run?.threadId !== review.threadId || run?.resourceId !== review.resourceId) return false
  if (!call.requiresApproval && questionSuspensionSchema.parse(call.suspendPayload).externalId !== review.externalId) return false
  return fingerprintPusharyAction(toolInput(call)) === review.inputHash
}

const verifyDecision = (value: unknown, review: PusharyAgentReviewBinding & { decisionId: string }) => {
  const decision = decisionSchema.parse(value)
  if (decision.decisionId !== review.decisionId || (decision.externalId !== null && decision.externalId !== review.externalId) ||
    decision.type !== review.question.type || decision.question !== review.question.question ||
    fingerprintPusharyAction(decision.options ?? []) !== fingerprintPusharyAction(review.question.options ?? []) ||
    decision.context !== bindingContext(review)) {
    throw new Error('Pushary: decision does not match the saved customer and action binding.')
  }
  return decision
}

export const createPusharyDeferredAskTool = (
  config: PusharyMastraConfig,
  opts: { externalId: string; id?: string; description?: string },
) => createTool({
  id: opts.id ?? 'ask-human',
  description: opts.description ?? 'Ask this customer yes/no, a choice, or a written answer in the Pushary mobile app. Pauses until they answer.',
  inputSchema: pusharyQuestionSchema,
  suspendSchema: questionSuspensionSchema,
  resumeSchema: z.object({ decisionId: id }),
  outputSchema: pusharyAnswerSchema,
  execute: async (request, context) => {
    const agent = context?.agent
    if (!agent) throw new Error('Pushary: the deferred question tool must run inside a Mastra agent.')
    if (!agent.resumeData) {
      return await agent.suspend({ pushary: 'question', externalId: externalIdSchema.parse(opts.externalId), request })
    }
    const decision = decisionSchema.parse(await client(config).decisions.get(agent.resumeData.decisionId))
    const binding = reviewContextSchema.parse(JSON.parse(decision.context))
    const runtime = z.object({ runId: id.optional() }).parse(agent)
    if (binding.kind !== 'question' || binding.agentId !== agent.agentId || binding.toolCallId !== agent.toolCallId ||
      binding.externalId !== opts.externalId || (runtime.runId !== undefined && binding.runId !== runtime.runId) || binding.threadId !== agent.threadId || binding.resourceId !== agent.resourceId ||
      binding.inputHash !== fingerprintPusharyAction(request) || binding.questionHash !== fingerprintPusharyAction(request)) {
      throw new Error('Pushary: resumed question does not match this customer and tool call.')
    }
    const verified = verifyDecision(decision, { ...binding, question: request, decisionId: agent.resumeData.decisionId })
    if (verified.status === 'pending') throw new Error('Pushary: the customer has not answered yet.')
    return answerPusharyQuestion(request, verified.status, verified.value)
  },
})

export const openPusharyAgentReview = async (
  config: PusharyMastraConfig,
  target: {
    agent: ApprovableAgent
    agentId: string
    runId: string
    toolCallId: string
    externalId: string
    actionVersion: string
    store: PusharyAgentReviewStore
    callbackUrl?: string
    question?: string
    subject?: Pick<CreateDecision, 'parameters' | 'presentation' | 'toolTarget' | 'actor' | 'environment'>
    expiresInSeconds?: number
    requireReachable?: boolean
  },
): Promise<PusharyAgentReview> => {
  const run = (await target.agent.listSuspendedRuns()).runs.find((item) => item.runId === target.runId)
  const toolCall = run?.toolCalls.find((item) => item.toolCallId === target.toolCallId)
  if (!run || !toolCall?.toolName) throw new Error('Pushary: the exact agent tool call is not suspended.')
  const suspension = toolCall.requiresApproval ? null : questionSuspensionSchema.parse(toolCall.suspendPayload)
  if (suspension && suspension.externalId !== target.externalId) throw new Error('Pushary: question customer does not match.')
  const question: PusharyQuestion = suspension?.request ?? {
    type: 'confirm',
    question: target.question ?? renderApprovalQuestion(toolCall.toolName, toolCall.args),
  }
  const subject = { ...target.subject, parameters: target.subject?.parameters ?? deriveParameters(toolCall.args) }
  const binding = reviewBindingSchema.parse({
    version: 1,
    agentId: target.agentId,
    runId: run.runId,
    toolCallId: target.toolCallId,
    toolName: toolCall.toolName,
    externalId: target.externalId,
    actionVersion: target.actionVersion,
    kind: toolCall.requiresApproval ? 'approval' : 'question',
    inputHash: fingerprintPusharyAction(toolInput(toolCall)),
    subjectHash: fingerprintPusharyAction(subject),
    question,
    threadId: run.threadId,
    resourceId: run.resourceId,
  })
  const context = bindingContext(binding)
  const created = await createDurableDecision(config, {
    ...question,
    ...subject,
    externalId: binding.externalId,
    node: binding.toolName,
    context,
    idempotencyKey: deterministicKey([context]),
    callbackUrl: target.callbackUrl,
    expiresInSeconds: target.expiresInSeconds,
    requireReachable: target.requireReachable,
  })
  const review = pusharyAgentReviewSchema.parse({ ...binding, ...created, state: 'pending' })
  await target.store.save(review)
  return review
}

export type PusharyAgentResumeOutcome<TOutput> =
  | { status: 'resumed'; review: PusharyAgentReview; output: TOutput; pending: readonly SuspendedAgentRun[]; discoveryError?: string }
  | { status: 'uncertain'; reason?: string; output?: TOutput; persistenceError?: string }
  | { status: 'pending' | 'busy' | 'duplicate' | 'unknown' | 'stale'; reason?: string }

export const resumePusharyAgentReview = async <TOutput>(
  config: PusharyMastraConfig,
  target: {
    agent: ResumablePusharyAgent<TOutput>
    agentId: string
    externalId: string
    decisionId: string
    store: PusharyAgentReviewStore
    currentActionVersion: (review: PusharyAgentReview) => Promise<string>
  },
): Promise<PusharyAgentResumeOutcome<TOutput>> => {
  const saved = await target.store.get(id.parse(target.decisionId))
  if (!saved) return { status: 'unknown' }
  const review = pusharyAgentReviewSchema.parse(saved)
  if (review.agentId !== target.agentId || review.externalId !== target.externalId || review.decisionId !== target.decisionId) {
    throw new Error('Pushary: review belongs to a different customer or agent.')
  }
  if (review.state === 'completed') return { status: 'duplicate' }
  if (review.state === 'uncertain' || review.state === 'stale') return { status: review.state }
  if (review.state === 'resuming') return { status: 'busy' }
  const decision = verifyDecision(await client(config).decisions.get(review.decisionId), review)
  if (decision.status === 'pending') return { status: 'pending' }
  const answer = answerPusharyQuestion(review.question, decision.status, decision.value)
  const scope = { threadId: review.threadId, resourceId: review.resourceId }
  const claimed = await target.store.claim(review.decisionId, review.runId)
  if (claimed !== 'claimed') return { status: claimed === 'busy' ? 'busy' : 'duplicate' }
  let output: TOutput | undefined
  try {
    const current = (await target.agent.listSuspendedRuns(scope)).runs.find((run) => run.runId === review.runId)
    if (!sameCall(review, current) || await target.currentActionVersion(review) !== review.actionVersion) {
      await target.store.finish(review.decisionId, 'stale', 'The call or business action changed before resumption.')
      return { status: 'stale' }
    }
    const call = { runId: review.runId, toolCallId: review.toolCallId }
    output = review.kind === 'question'
      ? await target.agent.resumeGenerate({ decisionId: review.decisionId }, call)
      : answer.approved
        ? await target.agent.approveToolCallGenerate(call)
        : await target.agent.declineToolCallGenerate({ ...call, reason: decision.status === 'answered' ? 'The customer declined.' : `The review ${decision.status}.` })
    await target.store.finish(review.decisionId, 'completed')
    try {
      const pending = (await target.agent.listSuspendedRuns(scope)).runs.filter((run) => run.runId === review.runId)
      if (suspendedOutput.safeParse(output).success && pending.length === 0) throw new Error('Mastra returned a suspension but its snapshot is not discoverable.')
      return { status: 'resumed', review: { ...review, state: 'completed' }, output, pending }
    } catch (error) {
      return { status: 'resumed', review: { ...review, state: 'completed' }, output, pending: [], discoveryError: error instanceof Error ? error.message : String(error) }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    try {
      await target.store.finish(review.decisionId, 'uncertain', reason)
      return { status: 'uncertain', reason, output }
    } catch (persistenceError) {
      return { status: 'uncertain', reason, output, persistenceError: persistenceError instanceof Error ? persistenceError.message : String(persistenceError) }
    }
  }
}
