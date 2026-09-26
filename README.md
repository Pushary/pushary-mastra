# @pushary/mastra

Phone approvals for Mastra agents. Your agent asks, your user taps Approve or Deny.

[Integration guide](https://pushary.com/human-in-the-loop-mastra?utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-mastra&utm_content=guide) · [Connect your customer’s phone](https://pushary.com/sign-up?from=agent&plan=partner&utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-mastra&utm_content=partner-start) · [Report a problem](https://github.com/Pushary/pushary-mastra/issues)

## What you need

- A Pushary Partner plan, from $99 a month. [Start the trial](https://pushary.com/sign-up?from=agent&plan=partner&utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-mastra&utm_content=partner-start).
- An API key from [Partner onboarding](https://pushary.com/onboarding/partner), set as `PUSHARY_API_KEY`.
- Your users install the free Pushary app ([iPhone](https://apps.apple.com/us/app/pushary/id6785677563), [Android](https://play.google.com/store/apps/details?id=com.pushary.app)). They never sign up or pay.

## Quick start

```bash
npm install @pushary/mastra @mastra/core zod
```

```ts
import { Agent } from '@mastra/core/agent'
import { connect, createPusharyAskTool } from '@pushary/mastra'

const config = { apiKey: process.env.PUSHARY_API_KEY! }
const { universalLink } = await connect(config, authenticatedCustomer.id)
// Once per user: show universalLink as a button or QR code.

const agent = new Agent({
  id: 'support',
  name: 'Support',
  instructions: 'Ask the customer before you refund an order.',
  model: 'openai/gpt-4o',
  tools: { askHuman: createPusharyAskTool(config, { externalId: authenticatedCustomer.id }) },
})
```

Deliver this single-use enrollment link inside your authenticated product. The customer installs the native app and enables notifications. Enrollment binds their phone to your customer ID. Customer IDs are opaque: whitespace is preserved, blank IDs are rejected, and IDs over 256 UTF-16 code units are rejected before creating a review. Real delivery requires Pushary Partner access; neither a browser simulation nor a successful provider response proves the person saw the notification.

`createPusharyAskTool` asks and waits for the answer. The model chooses when to call it, so it cannot force approval before another tool. For that, use Mastra's own `requireApproval` (below). Use yes or no for permission, a choice to pick between options, and text for missing information. Yes or no can be answered from the lock screen. Choices and text open the app. The existing web/PWA surface remains a compatibility option.

Mastra's own approval docs: [Agent approval](https://mastra.ai/docs/agents/agent-approval).

## Run an approval locally

Use Node.js 22.13 or later:

```bash
git clone https://github.com/Pushary/pushary-mastra.git
cd pushary-mastra
npm install
npm run test:restart
```

No account, API key or model provider is needed. This example starts a real Mastra agent, exits, and resumes it in a fresh process after simulated approval, denial, choice and text answers. Refunds are simulated; it checks that a repeated answer does not execute the refund twice.

[Follow the example on your phone](examples/README.md). The adapter is MIT-licensed. Real phone delivery uses the hosted Pushary service and requires developer Partner access; your customer needs the app, not a paid plan.

## Require approval before a tool executes

Set Mastra's native `requireApproval` on the protected tool. Pass `policy: false` when a real person must answer even if a workspace policy would allow the action.

```ts
import { createTool } from '@mastra/core/tools'
import { resolvePusharyApprovals } from '@pushary/mastra'
import { z } from 'zod'

const issueRefund = createTool({
  id: 'issue-refund',
  description: 'Refund an order',
  inputSchema: z.object({ orderId: z.string(), amount: z.number().positive() }),
  outputSchema: z.object({ refunded: z.boolean() }),
  requireApproval: true,
  execute: async (input) => refundOrderIdempotently(input),
})

const output = await agent.generate('Refund this order', {
  memory: { thread: customerConversation.id, resource: authenticatedCustomer.id },
})
if (output.finishReason === 'suspended') {
  const { runs } = await agent.listSuspendedRuns({ resourceId: authenticatedCustomer.id })
  const outcome = await resolvePusharyApprovals(
    { ...config, externalId: authenticatedCustomer.id, policy: false, maxApprovals: 5 },
    { agent, runs: runs.filter((run) => run.runId === output.runId) },
  )
  for (const review of outcome.resolved) {
    if (review.output) await saveAgentOutput(review.runId, review.output)
    if (review.reviewError || review.resumeError || review.discoveryError) await flagForRecovery(review)
  }
  await handlePendingRuns(outcome.pending)
}
```

Register `issueRefund` in the agent's tools and configure its storage. The example's business functions belong to your application.

The resolver forwards native tool arguments as structured input. Its optional `subject(pending)` supplies trusted parameters, presentation, action target, actor, environment, and context. Resolve customer identity from authenticated application ownership; never from model-supplied tool arguments. Supply trusted `runs`, `threadId`, or `resourceId`; unfiltered global resolution is rejected.

Each resumed generation is returned as `resolved[].output`. A customer-routing, question-preparation, missing-call-identity, or gate failure is returned as `reviewError` with that run still pending; its resume was not attempted. `resumeError` means the native resume was attempted and failed. Either outcome preserves earlier generations in the same batch. Subsequent suspensions are rediscovered; the resolver stops at `maxApprovals` (default 10), a data question, or an error and returns pending work. `allApproved` requires no pending work or recovery errors. It does not mean an arbitrary business side effect succeeded.

Without `policy: false`, the shared gate can resolve via policy. This blocking helper denies unanswered calls when its local wait ends. Use deferred reviews when the customer may answer after the request finishes.

## Defer agent reviews without holding a request open

The agent remains a Mastra agent. Mastra persists its suspended execution; Pushary stores and delivers the question. Your application stores the small mapping between them and controls who may resume it.

For protected actions, keep `requireApproval: true`. For questions, install the deferred ask tool:

```ts
import { createPusharyDeferredAskTool, openPusharyAgentReview } from '@pushary/mastra'

const askHuman = createPusharyDeferredAskTool(config, { externalId: authenticatedCustomer.id })

const output = await agent.generate('Prepare this order', {
  memory: { thread: customerConversation.id, resource: authenticatedCustomer.id },
})
if (output.finishReason === 'suspended') {
  const { runs } = await agent.listSuspendedRuns({ resourceId: authenticatedCustomer.id })
  const run = runs.find((item) => item.runId === output.runId)
  if (run) {
    for (const call of run.toolCalls) {
      await openPusharyAgentReview(config, {
        agent,
        agentId: 'order-agent',
        runId: run.runId,
        toolCallId: call.toolCallId!,
        externalId: authenticatedCustomer.id,
        actionVersion: order.draftVersion,
        store: reviewStore,
        callbackUrl: `${publicUrl}/pushary/callback`,
        expiresInSeconds: 3600,
        requireReachable: true,
      })
    }
  }
}
```

Register `askHuman` on the agent alongside its protected tools. Only pass approvals or suspensions from this package's deferred ask tool to `openPusharyAgentReview`; other tools may define different resume protocols. Disable conversational automatic tool resumption for customer-review flows and keep Mastra's resume APIs on your trusted server.

Opening a review happens after native suspension, so the snapshot exists before the notification is sent. The saved binding includes agent, run, tool call, customer, question, exact input fingerprint, trusted subject fingerprint, and business action version. Reopening the same review is idempotent; changing the recipient, question, arguments, subject, or version creates a different identity. Context stores fingerprints instead of duplicating the question and is validated against the API's 2,000-character limit before creation. Keep `actionVersion` stable for the same validated draft and change it whenever that business action changes. A tool-call ID identifies one invocation, not every future invocation of that tool.

### Receive and reconcile an answer

`callbackUrl` is optional for agent reviews. A polling worker can store the decision ID and call `resumePusharyAgentReview` later, without deploying a public callback endpoint. A `pending` result leaves the run suspended. Use the signed callback path below when you need immediate wake-up, with reconciliation as a fallback.

Verify the raw callback first. The callback's answer is not used as authority: the resume helper reads the current decision through the authenticated SDK, validates its saved binding and the returned question/options, and checks the native suspended call again. The API's cache may omit the recipient (`externalId: null`); that is accepted only when the authoritative context exactly matches the saved binding. A returned recipient must match. Mastra 1.59 does not expose a run ID inside the question tool's execution context, so the resume helper performs the run-level check; do not bypass it with a direct tool resume call.

```ts
import { resolvePusharyCallback, resumePusharyAgentReview } from '@pushary/mastra'

export async function POST(request: Request) {
  const raw = await request.text()
  const callback = resolvePusharyCallback(raw, request.headers.get('x-pushary-signature'), webhookSecret)
  if (!callback) return new Response('Invalid signature', { status: 401 })

  const saved = await reviewStore.get(callback.correlationId)
  if (!saved) return new Response('Review mapping not ready', { status: 503 })

  const result = await resumePusharyAgentReview(config, {
    agent: getAgent(saved.agentId),
    agentId: saved.agentId,
    externalId: saved.externalId,
    decisionId: saved.decisionId,
    store: reviewStore,
    currentActionVersion: (review) => readCurrentDraftVersion(review),
  })
  await recordResumeOutcome(result)
  if (['unknown', 'busy', 'pending'].includes(result.status)) return new Response('Retry later', { status: 503 })
  return new Response('Recorded', { status: 200 })
}
```

For long generations, durably enqueue the verified callback and run this work in your worker. Persist callback receipt before acknowledging it. Retry `unknown` after the create-to-save window and `busy` after another resume finishes. Reconcile pending review records against the SDK periodically because webhook delivery has bounded retries. `resumePusharyAgentReview` also works from that reconciliation job without a callback.

A resumed result returns the full generation and any newly suspended run. Handle both, then create reviews for the new calls as needed. A discovery error is returned alongside the generated output so it can be retried without rerunning the action. Confirm `yes` permits an approval; `no`, expiry, or cancellation declines it. Select and input resume the question tool with the original value and `approved: false`, including when the text is literally `yes`.

### Durable store and recovery contract

`PusharyAgentReviewStore` has four operations:

| Operation | Required behavior |
|---|---|
| `save(review)` | Insert the immutable binding idempotently; refuse conflicting identity and never reset existing state. |
| `get(decisionId)` | Read durable state. Validate serialized records with `pusharyAgentReviewSchema`. |
| `claim(decisionId, runId)` | Atomically move pending to resuming. Only one worker may claim a decision; serialize all resumes for the same run. Return `busy` if that run has a resuming or uncertain record, otherwise `settled` for an already terminal decision. |
| `finish(decisionId, state, reason?)` | Set completed, stale, or uncertain from the claimed state. Persist diagnostic reasons. |

[The SQLite example](examples/review-store.mjs) implements these rules with a transaction. It is appropriate for processes sharing that database file. Use your existing transactional database for distributed hosts; an in-memory map cannot coordinate workers or survive a restart. All resumers for a customer run must use the same coordination boundary.

A stale review never resumes. Regenerate the business action and request review for its new version. A resume exception is uncertain: it may have executed before the response was lost. The helper records uncertainty and never automatically retries that decision. If persisting that outcome also fails, it returns `persistenceError` alongside any generated output and leaves the original claim for recovery. A process crash while resuming similarly leaves a visible claimed record. Your recovery job must alert on these states, inspect the Mastra snapshot and the business system's execution receipt, then mark the record completed if execution is confirmed. Otherwise stop/cancel the obsolete run and reconcile the business action before creating a replacement. Do not reset a claim just because a timeout elapsed. Preserve the original binding and recovery reason.

An application version check before resumption cannot prevent a concurrent edit by itself. Validate that same business revision inside the protected tool, preferably with the database write's conditional update. Business side effects still need their own idempotency keys or reconciliation; this adapter does not promise exactly-once external execution.

## Short questions and workflows

`createPusharyAskTool(config, { externalId })` is the blocking form of confirm/select/input. It returns `{ approved, value, status }`. A model-selectable question tool alone cannot enforce approval before another tool.

`pusharyApprovalStep` retains the existing workflow integration and now accepts all three types:

```ts
import { pusharyApprovalStep, pusharyApprovalStepInputSchema, pusharyAnswerSchema } from '@pushary/mastra'
import { createWorkflow } from '@mastra/core/workflows'

const review = pusharyApprovalStep(config, { callbackUrl, externalId: authenticatedCustomer.id })
const workflow = createWorkflow({
  id: 'customer-review',
  inputSchema: pusharyApprovalStepInputSchema,
  outputSchema: pusharyAnswerSchema,
}).then(review).commit()
```

Input includes `operationId`, `question`, `type`, optional select `options`, and an external ID unless configured on the step. Each operation ID must identify one business action/revision, including each foreach item. Resume its correlation label with `{ answer, status: 'answered' }`, or `{ answer: null, status: 'expired' }`. The legacy `{ answer }` form defaults to answered. Output adds `status` and permits a null value for expiration/cancellation. A later workflow step must explicitly check `approved` before a protected action; branching on a truthy text answer is not approval. Only your authenticated callback/reconciliation handler should supply resume data after validating the saved operation binding.

## Runtime requirements

This version requires `@pushary/server ^2.1.0`, Mastra `>=1.59.0 <2.0.0`, and Node.js 22.13 or later, matching Mastra's runtime requirement. Configure Mastra with persistent storage for delayed answers.

## Run without a model, phone, account, or network

```bash
npm install
npm test
npm run typecheck
npm run test:restart
```

The [restart example](examples/durable-agent.mjs) uses real Mastra agents, the real SQLite storage provider, an application review table, and a scripted model. It starts a review in one process and resumes it in a fresh process for approval, denial, selection, and text. It checks that denial never runs the simulated refund, a repeated answer never resumes it twice, and select/input preserve `yes` as data. It leaves SQLite evidence in a temporary directory. HTTP responses are simulated; this does not exercise native notification delivery.

Unit tests cover tenant/context mismatch, early callbacks, concurrent claims, stale inputs/versions, expiration, uncertainty, and subsequent suspensions. A real parallel workflow test covers all three question types. Real mobile enrollment and physical-device notification handling require a separate integration check.

## Exercise the real phone path

Run these commands from this package's source checkout after `npm install` and `npm run build`. Supply a **Partner** API key through your local secret environment as `PUSHARY_API_KEY` and the enrolled customer's exact ID as `PUSHARY_EXTERNAL_ID`. The key must belong to a workspace with Partner access; Partner onboarding normally issues an Agent-scoped runtime key. Set `PUSHARY_BASE_URL` only when using a different API environment, including its `/api/v1/server` path.

If the test customer has not enrolled, run this once and open the printed private enrollment link on their phone:

```bash
node examples/durable-agent.mjs --live connect
```

Start a review, answer it in the native app, and continue the saved agent in a separate process:

```bash
node examples/durable-agent.mjs --live start /tmp/pushary-phone-check approve
node examples/durable-agent.mjs --live answer /tmp/pushary-phone-check approve
```

The live mode uses real Pushary HTTP requests and requires a reachable recipient. It still uses a scripted model and a local simulated refund, so no model key is needed and no money moves. There is no public callback server to configure. `answer` checks once and prints `pending` if the person has not answered; run it again after answering, or invoke it from your existing job scheduler. Decisions expire after one hour. Stop and restart the runner or phone app while pending to exercise recovery.

Repeat with `deny`, `select`, and `input` in place of `approve`. Each scenario gets separate SQLite files in the given directory. Confirm `yes` is permission; selections and text remain data. The runner verifies the returned values, checks simulated execution counts, saves the generated output, and checks that another resume returns `duplicate`. Repeating `start` while pending reuses the saved run and review. A completed, stale, busy, or uncertain action is never silently restarted. Use a new directory for a new business action, and keep these local databases private. Switching customer, API environment, or credential for an existing directory is rejected; restore the original configuration to finish that action. The database stores only a credential fingerprint, never the key. If a process dies after Mastra finishes but before the example saves its output, a duplicate with missing output exits with an error for manual recovery; it never executes the action again.

The automated transport check drives this same live CLI through a local HTTP server, with separate processes for start and answer:

```bash
npm run test:live-http
```

That check covers pending answers, start retries, approval, denial, selection, text, duplicate resumption, and customer isolation. It is not evidence of physical notification delivery. Record a real phone run before making that claim. OS notification delivery and in-app behavior also require the native/server review changes to be available in your test environment.

MIT
