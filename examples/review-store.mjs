import { pusharyAgentReviewSchema } from '../dist/index.js'

export const createReviewStore = (database) => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      decision_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      state TEXT NOT NULL,
      reason TEXT
    );
    CREATE INDEX IF NOT EXISTS reviews_run ON reviews(run_id, state);
  `)
  return {
    async save(review) {
      const parsed = pusharyAgentReviewSchema.parse(review)
      database.prepare('INSERT OR IGNORE INTO reviews VALUES (?, ?, ?, ?, NULL)').run(parsed.decisionId, parsed.runId, JSON.stringify(parsed), parsed.state)
      const existing = database.prepare('SELECT payload FROM reviews WHERE decision_id = ?').get(parsed.decisionId)
      if (existing.payload !== JSON.stringify(parsed)) throw new Error('Conflicting review identity')
    },
    async get(decisionId) {
      const row = database.prepare('SELECT payload, state FROM reviews WHERE decision_id = ?').get(decisionId)
      return row ? pusharyAgentReviewSchema.parse({ ...JSON.parse(row.payload), state: row.state }) : null
    },
    async claim(decisionId, runId) {
      database.exec('BEGIN IMMEDIATE')
      try {
        const row = database.prepare('SELECT state FROM reviews WHERE decision_id = ? AND run_id = ?').get(decisionId, runId)
        let result = row && ['resuming', 'uncertain'].includes(row.state) ? 'busy' : 'settled'
        if (row?.state === 'pending') {
          const active = database.prepare("SELECT decision_id FROM reviews WHERE run_id = ? AND state IN ('resuming', 'uncertain')").get(runId)
          if (active) result = 'busy'
          else {
            database.prepare("UPDATE reviews SET state = 'resuming' WHERE decision_id = ?").run(decisionId)
            result = 'claimed'
          }
        }
        database.exec('COMMIT')
        return result
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
    async finish(decisionId, state, reason) {
      const changed = database.prepare("UPDATE reviews SET state = ?, reason = ? WHERE decision_id = ? AND state = 'resuming'").run(state, reason ?? null, decisionId)
      if (changed.changes !== 1) throw new Error('Review is no longer claimed')
    },
  }
}
