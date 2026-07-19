import { createTool } from '@mastra/core/tools'
import { createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import {
  askExternalUser,
  createDurableDecision,
  isAffirmative,
  type PusharyMastraConfig,
} from './core'

export * from './core'

const DEFAULT_DESCRIPTION =
  'Ask a real human to approve, choose, or answer. Delivered to their phone and answered from the lock screen. Blocks until they reply. Use before any risky or irreversible action or when you need a human decision.'

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
 * fail-closed. Add it to any `Agent({ tools })`. For waits longer than a request can
 * hold, use `pusharyApprovalStep` in a workflow instead.
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
    inputSchema: z.object({
      question: z.string().describe('The exact question to put to the human.'),
      type: z
        .enum(['confirm', 'select', 'input'])
        .default('confirm')
        .describe('confirm = yes/no, select = pick an option, input = free text.'),
      options: z.array(z.string()).optional().describe('The choices, for a select question.'),
    }),
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
  /**
   * The end-user who decides. Omit to take it from the step's `inputData.externalId`
   * (safe: step input comes from your workflow, not the model).
   */
  readonly externalId?: string
  readonly id?: string
}

/**
 * A Mastra workflow `createStep` that suspends until a human answers on their phone,
 * then resumes on Pushary's signed webhook. Mastra persists the workflow snapshot, so
 * an hour-long wait holds no idle compute and survives a restart.
 *
 * ```ts
 * const approval = pusharyApprovalStep(
 *   { apiKey: KEY },
 *   { callbackUrl: `${process.env.PUBLIC_URL}/api/pushary/callback` },
 * )
 * const wf = createWorkflow({ id: 'refund', inputSchema, outputSchema }).then(approval).commit()
 * ```
 *
 * Resume from the callback route:
 * `run.resume({ step: approval, resumeData: { answer: cb.answer } })`.
 */
export const pusharyApprovalStep = (config: PusharyMastraConfig, opts: PusharyApprovalStepOptions) =>
  createStep({
    id: opts.id ?? 'pushary-approval',
    inputSchema: z.object({
      question: z.string(),
      externalId: z.string().optional(),
    }),
    suspendSchema: z.object({
      decisionId: z.string(),
      correlationId: z.string(),
    }),
    resumeSchema: z.object({
      answer: z.string(),
    }),
    outputSchema: z.object({
      approved: z.boolean(),
      value: z.string(),
    }),
    execute: async ({ inputData, resumeData, suspend }) => {
      if (!resumeData) {
        const externalId = opts.externalId ?? inputData.externalId
        if (!externalId) {
          throw new Error('pushary: externalId is required (set it on the step options or the step input).')
        }
        const { decisionId, correlationId } = await createDurableDecision(config, {
          question: inputData.question,
          externalId,
          node: opts.id ?? 'pushary-approval',
          callbackUrl: opts.callbackUrl,
        })
        return await suspend({ decisionId, correlationId })
      }
      return { approved: isAffirmative(resumeData.answer), value: resumeData.answer }
    },
  })
