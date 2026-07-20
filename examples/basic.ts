/**
 * Minimal Mastra example: an agent with a blocking ask-human tool.
 *
 * Prereqs: npm i @pushary/mastra @mastra/core zod @ai-sdk/openai
 * Run:     PUSHARY_API_KEY=... OPENAI_API_KEY=... npx tsx examples/basic.ts
 */
import { Agent } from '@mastra/core/agent'
import { openai } from '@ai-sdk/openai'
import { connect, createPusharyAskTool } from '@pushary/mastra'

const config = { apiKey: process.env.PUSHARY_API_KEY! }
const userId = 'user_123'

async function main() {
  const { universalLink } = await connect(config, userId)
  console.log('Ask the user to open:', universalLink)

  const askHuman = createPusharyAskTool(config, { externalId: userId })
  const agent = new Agent({
    name: 'Support',
    instructions: 'Call ask-human before any refund.',
    model: openai('gpt-4o'),
    tools: { askHuman },
  })

  const res = await agent.generate('Issue a $40 refund if a human approves.')
  console.log(res.text)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
