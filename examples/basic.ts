import { Agent } from '@mastra/core/agent'
import { connect, createPusharyAskTool } from '@pushary/mastra'

const config = { apiKey: process.env.PUSHARY_API_KEY! }
const externalId = 'customer_123'

async function main() {
  const { universalLink } = await connect(config, externalId)
  console.log('Open the enrollment link on your phone:', universalLink)
  const agent = new Agent({
    id: 'customer-support',
    name: 'Support',
    instructions: 'Ask the customer which delivery option they prefer.',
    model: 'openai/gpt-4o',
    tools: { askHuman: createPusharyAskTool(config, { externalId }) },
  })
  const result = await agent.generate('Ask whether standard or express delivery works best.')
  console.log(result.text)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
