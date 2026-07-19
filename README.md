# @pushary/mastra

[![CI](https://github.com/Pushary/pushary-mastra/actions/workflows/ci.yml/badge.svg)](https://github.com/Pushary/pushary-mastra/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@pushary/mastra)](https://www.npmjs.com/package/@pushary/mastra)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Full walkthrough: [Human-in-the-loop for Mastra](https://pushary.com/human-in-the-loop-mastra). Reaching your own end-users on their phones is the Pushary [Partner plan](https://pushary.com/human-in-the-loop).

Human-in-the-loop for [Mastra](https://mastra.ai). Ask a real human to approve, and
get the answer on their phone. Two seams, pick by wait length:

- **A blocking `createTool`** for an approval that resolves in well under a minute.
- **A durable workflow step** (`suspend`/`resume`) for long waits. Mastra persists the
  snapshot, so the wait holds no idle compute and survives a restart.

Requires the Pushary [Partner plan](https://pushary.com/agent-notifications-integration)
and `@mastra/core` v1.

## Install

```bash
npm i @pushary/mastra @mastra/core zod
```

Set `PUSHARY_API_KEY` (get it in your [dashboard](https://pushary.com/dashboard/settings)).

## Connect a phone once

```ts
import { connect } from '@pushary/mastra'
const { universalLink } = await connect({ apiKey: process.env.PUSHARY_API_KEY! }, user.id)
```

## Blocking tool

```ts
import { createPusharyAskTool } from '@pushary/mastra'
import { Agent } from '@mastra/core/agent'

const askHuman = createPusharyAskTool({ apiKey: process.env.PUSHARY_API_KEY! }, { externalId: user.id })

const agent = new Agent({
  name: 'Support',
  instructions: 'Call ask-human before any refund.',
  model,
  tools: { askHuman },
})
```

The tool blocks until the person answers and returns `{ approved, value, status }`,
fail-closed. `externalId` is bound in code, never taken from model input.

## Durable step

```ts
import { pusharyApprovalStep } from '@pushary/mastra'
import { createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'

const approval = pusharyApprovalStep(
  { apiKey: process.env.PUSHARY_API_KEY! },
  { callbackUrl: `${process.env.PUBLIC_URL}/api/pushary/callback` },
)

export const refund = createWorkflow({
  id: 'refund',
  inputSchema: z.object({ question: z.string(), externalId: z.string() }),
  outputSchema: z.object({ approved: z.boolean(), value: z.string() }),
})
  .then(approval)
  .commit()
```

Run it, and it suspends at the approval step. Resume from the callback route:

```ts
import { resolvePusharyCallback } from '@pushary/mastra'

// POST /api/pushary/callback
export async function POST(req: Request) {
  const raw = await req.text()
  const cb = resolvePusharyCallback(raw, req.headers.get('x-pushary-signature'), process.env.PUSHARY_WEBHOOK_SECRET!)
  if (!cb) return new Response('bad signature', { status: 401 })
  const runId = await lookupRun(cb.correlationId) // your own correlationId -> runId map
  const run = await refund.createRun({ runId })
  await run.resume({ step: approval, resumeData: { answer: cb.answer } })
  return new Response('ok')
}
```

## API

- `connect(config, externalId)` — enroll an end-user's phone.
- `createPusharyAskTool(config, { externalId })` — a Mastra `createTool` that blocks on a human.
- `pusharyApprovalStep(config, { callbackUrl })` — a durable `createStep` with suspend/resume.
- `resolvePusharyCallback(raw, signature, secret)` — verify + parse a callback into `{ correlationId, answer, approved, ... }`.
- `askExternalUser`, `createDurableDecision`, `describeAnswer`, `isAffirmative`, `deterministicKey`, `SIGNATURE_HEADER`.

## License

MIT
