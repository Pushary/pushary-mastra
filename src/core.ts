// Framework-free core for @pushary/mastra. No @mastra/core imports here, so it
// unit-tests without the framework. The createTool / createStep bindings live in
// index.ts and build on these functions.

import {
  createPusharyServer,
  deterministicKey,
  isApproved,
  parseDecisionCallback,
  verifyWebhookSignature,
  SIGNATURE_HEADER,
  type AskResult,
  type DecisionType,
  type EnrollResult,
} from '@pushary/server'

export { SIGNATURE_HEADER, verifyWebhookSignature, parseDecisionCallback, deterministicKey }
export type { AskResult, DecisionType }

export interface PusharyMastraConfig {
  /** Your Pushary API key (pk_xxx.sk_xxx). Defaults to `process.env.PUSHARY_API_KEY`. */
  readonly apiKey?: string
  /** Shown on the approval so the human knows which agent is asking. */
  readonly agentName?: string
  /** How long a blocking ask waits before returning (default 55s, serverless-safe). */
  readonly timeoutMs?: number
  /** Override the API base URL (tests / self-host). */
  readonly baseUrl?: string
}

export interface PusharyAskInput {
  readonly question: string
  readonly externalId: string
  readonly node?: string
  readonly type?: DecisionType
  readonly options?: readonly string[]
  readonly context?: string
  readonly callbackUrl?: string
}

export interface CreatedDecision {
  readonly decisionId: string
  readonly correlationId: string
  readonly status: string
  readonly reachable?: boolean
  readonly reachableChannels?: number
  readonly deviceCount?: number
}

export interface PusharyCallback {
  readonly correlationId: string
  readonly answer: string
  readonly value: string
  readonly approved: boolean
  readonly context?: string
  readonly answeredAt: string
}

const resolveApiKey = (config: PusharyMastraConfig): string => {
  const key = config.apiKey ?? process.env.PUSHARY_API_KEY
  if (!key) {
    throw new Error('Pushary: set PUSHARY_API_KEY or pass { apiKey } to the Mastra helpers.')
  }
  return key
}

const clientFor = (config: PusharyMastraConfig) =>
  createPusharyServer({ apiKey: resolveApiKey(config), baseUrl: config.baseUrl })

const idempotencyKeyFor = (input: PusharyAskInput): string =>
  deterministicKey([input.externalId, input.node ?? 'ask-human', input.question])

/** Fail-closed yes/no check for a confirm answer. */
export const isAffirmative = (answer: string | null | undefined): boolean =>
  isApproved({ status: 'answered', type: 'confirm', value: answer ?? null })

/** Turn a decision outcome into an unambiguous instruction for the model. */
export const describeAnswer = (type: DecisionType, result: AskResult): string => {
  if (!result.answered) {
    return `No answer (status: ${result.status}). Treat this as NOT approved and do not proceed.`
  }
  if (type === 'confirm') {
    return result.approved ? 'The human approved. You may proceed.' : 'The human declined. Do not proceed.'
  }
  return `The human answered: ${result.value ?? ''}`
}

/**
 * Blocking ask (Pattern A): create a decision and poll durably until answered or the
 * deadline passes. Idempotency is keyed by externalId + node + question.
 */
export const askExternalUser = (config: PusharyMastraConfig, input: PusharyAskInput): Promise<AskResult> =>
  clientFor(config).decisions.ask({
    question: input.question,
    type: input.type,
    options: input.options,
    externalId: input.externalId,
    context: input.context,
    agentName: config.agentName,
    timeoutMs: config.timeoutMs,
    idempotencyKey: idempotencyKeyFor(input),
  })

/**
 * Durable create (Pattern B): open a decision with a callbackUrl and return at once.
 * Used by the suspend/resume step right before it suspends.
 */
export const createDurableDecision = async (
  config: PusharyMastraConfig,
  input: PusharyAskInput,
): Promise<CreatedDecision> => {
  const created = await clientFor(config).decisions.create({
    question: input.question,
    type: input.type,
    options: input.options,
    externalId: input.externalId,
    context: input.context,
    callbackUrl: input.callbackUrl,
    agentName: config.agentName,
    idempotencyKey: idempotencyKeyFor(input),
    wait: false,
  })
  return {
    decisionId: created.decisionId,
    correlationId: created.decisionId,
    status: created.status,
    reachable: created.reachable,
    reachableChannels: created.reachableChannels,
    deviceCount: created.deviceCount,
  }
}

/**
 * Verify a callback signature and parse it, or return null. Feed `answer` into
 * `run.resume({ step, resumeData: { answer } })`.
 */
export const resolvePusharyCallback = (
  rawBody: string,
  signature: string | null | undefined,
  secret: string,
): PusharyCallback | null => {
  if (!verifyWebhookSignature(rawBody, signature, secret)) return null
  const cb = parseDecisionCallback(rawBody)
  if (!cb) return null
  return {
    correlationId: cb.correlationId,
    answer: cb.answer,
    value: cb.value,
    approved: isAffirmative(cb.answer),
    context: cb.context,
    answeredAt: cb.answeredAt,
  }
}

/** Connect one end-user's phone (keyless). Show them the returned link. */
export const connect = (config: PusharyMastraConfig, externalId: string): Promise<EnrollResult> =>
  clientFor(config).enroll(externalId)
