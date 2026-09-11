import { z } from 'zod'
import { isAffirmative } from './core'
export { decisionFingerprint as fingerprintPusharyAction } from '@pushary/server/adapters'

export const pusharyQuestionSchema = z.object({
  question: z.string().trim().min(1).max(500),
  type: z.enum(['confirm', 'select', 'input']).default('confirm'),
  options: z.array(z.string().min(1).max(200)).max(20).optional(),
}).superRefine((question, ctx) => {
  const options = question.options ?? []
  if (question.type === 'select' && (options.length < 2 || new Set(options).size !== options.length)) {
    ctx.addIssue({ code: 'custom', path: ['options'], message: 'Select questions require at least two distinct, nonempty options.' })
  }
  if (question.type !== 'select' && question.options !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['options'], message: 'Only select questions accept options.' })
  }
})

export const pusharyAnswerSchema = z.object({
  status: z.enum(['answered', 'expired', 'cancelled']),
  value: z.string().nullable(),
  approved: z.boolean(),
})

export type PusharyQuestion = z.infer<typeof pusharyQuestionSchema>
export type PusharyAnswer = z.infer<typeof pusharyAnswerSchema>

export const answerPusharyQuestion = (
  question: PusharyQuestion,
  status: PusharyAnswer['status'],
  value: string | null,
): PusharyAnswer => {
  if (status !== 'answered') return { status, value: null, approved: false }
  if (value === null) throw new Error('Pushary: an answered decision has no value.')
  if (question.type === 'confirm' && value !== 'yes' && value !== 'no') {
    throw new Error('Pushary: a confirm answer must be yes or no.')
  }
  if (question.type === 'select' && !question.options?.includes(value)) {
    throw new Error('Pushary: the answer is not a configured option.')
  }
  return { status, value, approved: question.type === 'confirm' && isAffirmative(value) }
}
