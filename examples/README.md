# A customer answers after your agent exits

From this repository, use Node.js 22.13 or later:

```bash
npm install
npm run test:restart
```

The example uses Mastra's real agent suspension and persistent storage, a scripted model and simulated Pushary responses. It starts and resumes in separate processes for approvals, denials, choices and typed answers. No account, key or model provider is needed. The refund is a local counter; no money moves. Replaying an answer must not execute it twice.

## Connect your phone

[Start Partner onboarding](https://pushary.com/sign-up?from=agent&plan=partner&utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-mastra&utm_content=example-connect). Keep the Partner key server-side in `PUSHARY_API_KEY`. Set `PUSHARY_EXTERNAL_ID` to an opaque identifier for your test customer, obtained from trusted application ownership.

```bash
node examples/durable-agent.mjs --live connect
```

Open the returned private enrollment link on your phone. Install the native app, enable notifications and reopen the invitation after installation if needed. Your customer does not need a Pushary account or paid plan.

```bash
node examples/durable-agent.mjs --live start /tmp/pushary-phone-review approve
```

Answer on the phone, then run a fresh process using the same directory and credentials:

```bash
node examples/durable-agent.mjs --live answer /tmp/pushary-phone-review approve
```

A pending result means no answer is ready yet. Run the answer command again after answering; a completed duplicate should not resume the action twice. The model and refund remain simulated in live mode, while delivery uses your real Partner account and usage.

Repeat with `deny`, `select` or `input` in both start and answer commands. Use a fresh directory to repeat an already completed scenario. Never share enrollment links, keys, customer data or the SQLite files in public issues.

## Bring this into your product

Keep the existing application's job system and database. Adapt [the review store](review-store.mjs) and [agent example](durable-agent.mjs) to preserve the authenticated customer, exact tool call and draft version. Your application owns execution receipts and recovery. Follow the [integration contract](../README.md#defer-agent-reviews-without-holding-a-request-open) before using real business effects.

For help, include your Node, Mastra and adapter versions, the command, and redacted expected/actual output in a [public issue](https://github.com/Pushary/pushary-mastra/issues).
