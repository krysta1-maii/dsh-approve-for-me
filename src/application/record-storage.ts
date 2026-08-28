import { canonicalJson } from '../domain/json.js'
import { reviewRecordKey } from '../domain/records.js'
import type { ReviewDecisionRecordV1 } from '../domain/records.js'

export type StorageWriteResult = 'stored' | 'identical' | 'conflict' | 'unavailable'

export interface DecisionRecordStorageBackend {
  putIfAbsent(key: string, value: unknown, canonical: string): Promise<StorageWriteResult>
  read(key: string): Promise<unknown | undefined>
  drain(): Promise<void>
}

export interface DecisionRecordStore {
  createConfirmed(record: ReviewDecisionRecordV1): Promise<'confirmed' | 'conflict' | 'unavailable'>
  drain(): Promise<void>
}

/**
 * In-memory Storage Domain stand-in for tests and pre-DSH wiring. It enforces
 * create-once semantics by comparing the canonical JSON of the existing row;
 * a contradicting value is a conflict, never an overwrite.
 */
export class InMemoryDecisionRecordStorageBackend implements DecisionRecordStorageBackend {
  private readonly rows = new Map<string, { value: unknown; canonical: string }>()

  async putIfAbsent(key: string, value: unknown, canonical: string): Promise<StorageWriteResult> {
    const existing = this.rows.get(key)
    if (existing === undefined) {
      this.rows.set(key, { value: { ...(value as object) }, canonical })
      return 'stored'
    }
    return existing.canonical === canonical ? 'identical' : 'conflict'
  }

  async read(key: string): Promise<unknown | undefined> {
    return this.rows.get(key)?.value
  }

  async drain(): Promise<void> {
    // In-memory writes are synchronous; nothing to flush.
  }
}

/**
 * H4 create-once ReviewDecisionRecord writer using a Storage Domain-style
 * backend. Only `confirmed` back from the backend may count as durable for an
 * automatic allow; conflict and unavailable are surfaced to the gate mapping.
 */
export class ReviewDecisionRecordStore implements DecisionRecordStore {
  constructor(private readonly backend: DecisionRecordStorageBackend) {}

  async createConfirmed(record: ReviewDecisionRecordV1): Promise<'confirmed' | 'conflict' | 'unavailable'> {
    const key = reviewRecordKey(record.session, record.review.reviewRunId)
    const result = await this.backend.putIfAbsent(key, record, canonicalJson(record))
    if (result === 'stored' || result === 'identical') return 'confirmed'
    if (result === 'conflict') return 'conflict'
    return 'unavailable'
  }

  async drain(): Promise<void> {
    await this.backend.drain()
  }
}
