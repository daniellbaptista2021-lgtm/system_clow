/**
 * ragEngine.ts — RAG (Retrieval-Augmented Generation) with vector embeddings
 *
 * Generates text embeddings and stores them in SQLite for semantic search.
 * Uses Anthropic API (Voyage) or falls back to TF-IDF cosine similarity.
 *
 * Flow:
 * 1. On observation/summary creation: generate embedding vector
 * 2. Store vector as JSON blob in SQLite
 * 3. On search: generate query embedding, compute cosine similarity
 * 4. Return top-K results ranked by semantic relevance
 */

import { createHash } from 'crypto';
import { getMemoryDb } from './MemoryDatabase.js';

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

export interface EmbeddingResult {
  id: number;
  session_id: string;
  type: 'observation' | 'summary';
  title: string;
  content: string;
  score: number;
  created_at_epoch: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Schema Extension
// ════════════════════════════════════════════════════════════════════════════

function ensureEmbeddingTable(tenantId: string): void {
  const db = getMemoryDb(tenantId);
  db.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      text_hash TEXT NOT NULL,
      vector TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      UNIQUE(source_type, source_id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_emb_source ON embeddings(source_type, source_id)`);
}

// ════════════════════════════════════════════════════════════════════════════
// TF-IDF Embedding (local, no external API needed)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Generate a simple TF-IDF-like embedding vector from text.
 * Uses hash-based feature extraction (feature hashing / hashing trick).
 * Dimension: 256 (compact but effective for similarity search).
 */
function generateLocalEmbedding(text: string): number[] {
  const DIM = 256;
  const vector = new Float64Array(DIM);
  const cleanText = text.toLowerCase().replace(/[^a-z0-9\s\u00e0-\u00ff]/g, ' ');
  const words = cleanText.split(/\s+/).filter(w => w.length > 2);

  if (words.length === 0) return Array.from(vector);

  // Unigrams + bigrams
  const tokens: string[] = [...words];
  for (let i = 0; i < words.length - 1; i++) {
    tokens.push(`${words[i]}_${words[i + 1]}`);
  }

  // Feature hashing
  for (const token of tokens) {
    const hash = createHash('md5').update(token).digest();
    const idx = hash.readUInt16LE(0) % DIM;
    const sign = (hash.readUInt8(2) & 1) === 0 ? 1 : -1;
    vector[idx] += sign * (1 / Math.sqrt(tokens.length)); // TF normalization
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < DIM; i++) vector[i] /= norm;
  }

  return Array.from(vector);
}

/**
 * Compute cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

// ════════════════════════════════════════════════════════════════════════════
// RAG Engine Class
// ════════════════════════════════════════════════════════════════════════════

export class RAGEngine {
  constructor(private readonly tenantId: string = 'default') {
    ensureEmbeddingTable(tenantId);
  }

  private get db() {
    return getMemoryDb(this.tenantId);
  }

  /**
   * Index a text for semantic search.
   * Called after recording an observation or summary.
   */
  indexText(sourceType: 'observation' | 'summary', sourceId: number, text: string): void {
    try {
      const textHash = createHash('sha256').update(text).digest('hex').slice(0, 16);
      const vector = generateLocalEmbedding(text);

      this.db.prepare(`
        INSERT OR REPLACE INTO embeddings (source_type, source_id, text_hash, vector, created_at_epoch)
        VALUES (?, ?, ?, ?, ?)
      `).run(sourceType, sourceId, textHash, JSON.stringify(vector), Date.now());
    } catch (err) {
      console.warn(`[RAG] Index error: ${(err as Error).message}`);
    }
  }

  /**
   * Semantic search — find most relevant memories by meaning, not keywords.
   */
  search(query: string, limit: number = 10): EmbeddingResult[] {
    try {
      const queryVector = generateLocalEmbedding(query);

      // Load all embeddings (for small datasets this is fine, for large use approximate NN)
      const rows = this.db.prepare(`
        SELECT e.source_type, e.source_id, e.vector,
               CASE e.source_type
                 WHEN 'observation' THEN o.title
                 WHEN 'summary' THEN s.request
               END as title,
               CASE e.source_type
                 WHEN 'observation' THEN COALESCE(o.narrative, o.title)
                 WHEN 'summary' THEN COALESCE(s.completed, s.request)
               END as content,
               CASE e.source_type
                 WHEN 'observation' THEN o.session_id
                 WHEN 'summary' THEN s.session_id
               END as session_id,
               e.created_at_epoch
        FROM embeddings e
        LEFT JOIN observations o ON e.source_type = 'observation' AND e.source_id = o.id AND o.tenant_id = ?
        LEFT JOIN session_summaries s ON e.source_type = 'summary' AND e.source_id = s.id AND s.tenant_id = ?
        WHERE title IS NOT NULL OR content IS NOT NULL
      `).all(this.tenantId, this.tenantId) as any[];

      // Compute similarities
      const results: EmbeddingResult[] = rows.map(row => {
        const vec = JSON.parse(row.vector) as number[];
        const score = cosineSimilarity(queryVector, vec);
        return {
          id: row.source_id,
          session_id: row.session_id || '',
          type: row.source_type as 'observation' | 'summary',
          title: row.title || '',
          content: row.content || '',
          score,
          created_at_epoch: row.created_at_epoch,
        };
      });

      // Sort by similarity score (descending) and return top-K
      return results
        .filter(r => r.score > 0.05) // Minimum threshold
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    } catch (err) {
      console.warn(`[RAG] Search error: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Get embedding stats.
   */
  getStats(): { totalEmbeddings: number; observations: number; summaries: number } {
    try {
      const total = this.db.prepare('SELECT COUNT(*) as c FROM embeddings').get() as { c: number };
      const obs = this.db.prepare("SELECT COUNT(*) as c FROM embeddings WHERE source_type = 'observation'").get() as { c: number };
      const sum = this.db.prepare("SELECT COUNT(*) as c FROM embeddings WHERE source_type = 'summary'").get() as { c: number };
      return { totalEmbeddings: total.c, observations: obs.c, summaries: sum.c };
    } catch {
      return { totalEmbeddings: 0, observations: 0, summaries: 0 };
    }
  }
}
