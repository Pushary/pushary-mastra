import { createTool } from '@mastra/core/tools'
import { createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import {
  deterministicKey,
  askExternalUser,
  createDurableDecision,
  type PusharyMastraConfig,
} from './core'

export * from './core'
export * from './approval'
export * from './deferred'
export * from './questions'

import { answerPusharyQuestion, fingerprintPusharyAction, pusharyAnswerSchema, pusharyQuestionSchema } from './questions'

const DEFAULT_DESCRIPTION =
  'Ask a real human to approve, choose, or answer. Delivered to their phone. Blocks until they reply. Use before any risky or irreversible action or when you need a human decision.'

export interface PusharyAskToolOptions {
  /**
   * The enrolled end-user who answers. Bound here, NEVER taken from model input, so a
   * prompt-injected model cannot redirect an approval to another user.
   */
  readonly externalId: string
  /** Tool id the model calls (default "ask-human"). */
  readonly id?: string
  readonly description?: string
}

/**
 * A Mastra `createTool` that asks a real human and blocks until they answer,
 * fail-closed. Add it to any `Agent({ tools })`.
 *
 * ```ts
 * const askHuman = createPusharyAskTool({ apiKey: KEY }, { externalId: user.id })
 * const agent = new Agent({ name: 'Support', instructions: '...', tools: { askHuman } })
 * ```
 */
export const createPusharyAskTool = (config: PusharyMastraConfig, opts: PusharyAskToolOptions) =>
  createTool({
    id: opts.id ?? 'ask-human',
    description: opts.description ?? DEFAULT_DESCRIPTION,
    inputSchema: pusharyQuestionSchema,
    outputSchema: z.object({
      approved: z.boolean(),
      value: z.string().nullable(),
      status: z.string(),
    }),
    // Mastra v1: execute receives the validated input as the FIRST positional arg.
    execute: async ({ question, type, options }) => {
      const result = await askExternalUser(config, {
        question,
        type,
        options,
        externalId: opts.externalId,
        node: opts.id ?? 'ask-human',
      })
      return { approved: result.approved, value: result.value, status: result.status }
    },
  })

export interface PusharyApprovalStepOptions {
  /**
   * Where Pushary POSTs the signed callback. Store your `correlationId -> runId` map
   * and drive `run.resume` from a route that receives it.
   */
  readonly callbackUrl: string
  readonly expiresInSeconds?: number
  readonly requireReachable?: boolean
  /**
   * The end-user who decides. Omit to take it from the step's `inputData.externalId`
   * (safe: step input comes from your workflow, not the model).
   */
  readonly externalId?: string
  readonly id?: string
}

export const pusharyApprovalStepInputSchema = z.object({
  operationId: z.string().refine((value) => value.trim().length > 0, 'Operation ID cannot be blank.').describe('Unique action identity, stable on retries; distinct for each loop/foreach operation.'),
  question: z.string().trim().min(1).max(500),
  type: z.enum(['confirm', 'select', 'input']).default('confirm'),
  options: z.array(z.string().min(1).max(200)).max(20).optional(),
  externalId: z.string().optional(),
})

export const pusharyApprovalStep = (config: PusharyMastraConfig, opts: PusharyApprovalStepOptions) =>
  createStep({
    id: opts.id ?? 'pushary-approval',
    inputSchema: pusharyApprovalStepInputSchema,
    suspendSchema: z.object({
      decisionId: z.string(),
      correlationId: z.string(),
    }),
    resumeSchema: z.object({
      answer: z.string().nullable(),
      status: z.enum(['answered', 'expired', 'cancelled']).default('answered'),
    }),
    outputSchema: pusharyAnswerSchema,
    execute: async ({ inputData, resumeData, suspend, runId }) => {
      const question = pusharyQuestionSchema.parse(inputData)
      if (!resumeData) {
        if (!inputData.operationId?.trim()) throw new Error('pushary: operationId is required for each approval action.')
        const externalId = opts.externalId ?? inputData.externalId
        if (!externalId) {
          throw new Error('pushary: externalId is required (set it on the step options or the step input).')
        }
        const { decisionId, correlationId } = await createDurableDecision(config, {
          ...question,
          externalId,
          node: opts.id ?? 'pushary-approval',
          idempotencyKey: deterministicKey([runId, opts.id ?? 'pushary-approval', externalId, inputData.operationId, fingerprintPusharyAction(question)]),
          callbackUrl: opts.callbackUrl,
          expiresInSeconds: opts.expiresInSeconds,
          requireReachable: opts.requireReachable,
        })
        return await suspend({ decisionId, correlationId }, { resumeLabel: correlationId })
      }
      return answerPusharyQuestion(question, resumeData.status, resumeData.answer)
    },
  })
