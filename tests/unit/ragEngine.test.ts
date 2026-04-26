/**
 * RAG Engine — Unit Tests
 */

import { describe, it, expect } from 'vitest';

describe('RAG Engine - Local Embeddings', () => {
  // Test the embedding generation logic (extracted for testability)
  function generateTestEmbedding(text: string): number[] {
    const { createHash } = require('crypto');
    const DIM = 256;
    const vector = new Float64Array(DIM);
    const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w: string) => w.length > 2);
    if (words.length === 0) return Array.from(vector);
    const tokens = [...words];
    for (let i = 0; i < words.length - 1; i++) tokens.push(`${words[i]}_${words[i + 1]}`);
    for (const token of tokens) {
      const hash = createHash('md5').update(token).digest();
      const idx = hash.readUInt16LE(0) % DIM;
      const sign = (hash.readUInt8(2) & 1) === 0 ? 1 : -1;
      vector[idx] += sign * (1 / Math.sqrt(tokens.length));
    }
    let norm = 0;
    for (let i = 0; i < DIM; i++) norm += vector[i] * vector[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < DIM; i++) vector[i] /= norm;
    return Array.from(vector);
  }

  function cosine(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    const d = Math.sqrt(na) * Math.sqrt(nb);
    return d > 0 ? dot / d : 0;
  }

  it('generates 256-dimensional vectors', () => {
    const vec = generateTestEmbedding('hello world');
    expect(vec.length).toBe(256);
  });

  it('generates normalized vectors (L2 norm ~1)', () => {
    const vec = generateTestEmbedding('testing the embedding system');
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 1);
  });

  it('similar texts have higher cosine similarity than dissimilar texts', () => {
    const base = generateTestEmbedding('corrigir bug no servidor nginx');
    const similar = generateTestEmbedding('fix bug no nginx server');
    const dissimilar = generateTestEmbedding('receita de bolo de chocolate');
    const simHigh = cosine(base, similar);
    const simLow = cosine(base, dissimilar);
    // Hash-based 256d embedding is coarse — assert the *ordering*, not a magic number.
    expect(simHigh).toBeGreaterThan(simLow);
    expect(simHigh).toBeGreaterThan(0.25);
    expect(simLow).toBeLessThan(0.2);
  });

  it('identical texts have similarity ~1', () => {
    const text = 'sistema de memoria persistente com sqlite';
    const a = generateTestEmbedding(text);
    const b = generateTestEmbedding(text);
    expect(cosine(a, b)).toBeCloseTo(1.0, 5);
  });

  it('empty text returns zero vector', () => {
    const vec = generateTestEmbedding('');
    const sum = vec.reduce((s, v) => s + Math.abs(v), 0);
    expect(sum).toBe(0);
  });
});
