/**
 * Tests pras tools comuns. Foco no parseFollowupDate (FIX 2026-05-06).
 *
 * Bug original: 14 falhas/24h em agendar_followup com erro "data_invalida_ou_passada".
 * LLM passava formatos não-ISO ou data ligeiramente no passado (latência LLM).
 * Parser novo aceita: ISO 8601, ISO date-only ("YYYY-MM-DD" → 14h BRT),
 * formato BR ("DD/MM/YYYY HH:MM"), e relativo ("+24h", "+2d").
 */
import { describe, it, expect } from 'vitest';
import { parseFollowupDate } from '../../../src/crm/agents/tools/common.js';

describe('parseFollowupDate — formatos aceitos', () => {
  it('aceita ISO 8601 completo (UTC)', () => {
    const t = parseFollowupDate('2026-05-08T14:00:00Z');
    expect(t).toBe(Date.UTC(2026, 4, 8, 14, 0, 0));
  });

  it('aceita ISO 8601 com offset BRT', () => {
    const t = parseFollowupDate('2026-05-08T14:00:00-03:00');
    expect(t).toBe(Date.UTC(2026, 4, 8, 17, 0, 0));
  });

  it('aceita ISO date-only "YYYY-MM-DD" (assume 14h BRT = 17h UTC)', () => {
    const t = parseFollowupDate('2026-05-08');
    expect(t).toBe(Date.UTC(2026, 4, 8, 17, 0, 0));
  });

  it('aceita formato BR "DD/MM/YYYY HH:MM"', () => {
    const t = parseFollowupDate('08/05/2026 14:00');
    // BRT (UTC-3) → soma 3h pra UTC
    expect(t).toBe(Date.UTC(2026, 4, 8, 17, 0, 0));
  });

  it('aceita formato BR só data "DD/MM/YYYY" (assume 14h BRT)', () => {
    const t = parseFollowupDate('08/05/2026');
    expect(t).toBe(Date.UTC(2026, 4, 8, 17, 0, 0));
  });

  it('aceita relativo "+24h"', () => {
    const before = Date.now();
    const t = parseFollowupDate('+24h')!;
    const after = Date.now();
    const expected = before + 24 * 60 * 60 * 1000;
    expect(t).toBeGreaterThanOrEqual(expected);
    expect(t).toBeLessThanOrEqual(after + 24 * 60 * 60 * 1000);
  });

  it('aceita relativo "+2d"', () => {
    const before = Date.now();
    const t = parseFollowupDate('+2d')!;
    expect(t).toBeGreaterThanOrEqual(before + 2 * 24 * 60 * 60 * 1000 - 100);
  });

  it('aceita "+ 48h" com espaço', () => {
    const t = parseFollowupDate('+ 48h');
    expect(t).toBeGreaterThan(Date.now());
  });
});

describe('parseFollowupDate — formatos invalidos', () => {
  it('null pra string vazia', () => {
    expect(parseFollowupDate('')).toBeNull();
  });

  it('null pra texto livre', () => {
    expect(parseFollowupDate('amanhã às 14h')).toBeNull();
  });

  it('null pra "+0h"', () => {
    expect(parseFollowupDate('+0h')).toBeNull();
  });

  it('null pra "+9999d" (fora do limite)', () => {
    expect(parseFollowupDate('+9999d')).toBeNull();
  });

  it('null pra formato BR invalido', () => {
    expect(parseFollowupDate('32/05/2026')).not.toBeNull(); // Date.UTC normaliza
    expect(parseFollowupDate('texto qualquer')).toBeNull();
  });
});

describe('parseFollowupDate — formatos novos (HARDENING 4)', () => {
  it('aceita "+24 horas" (PT-BR completo)', () => {
    const before = Date.now();
    const t = parseFollowupDate('+24 horas')!;
    expect(t).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000 - 100);
  });

  it('aceita "+2 dias"', () => {
    const before = Date.now();
    const t = parseFollowupDate('+2 dias')!;
    expect(t).toBeGreaterThanOrEqual(before + 2 * 24 * 60 * 60 * 1000 - 100);
  });

  it('aceita "+1 dia" singular', () => {
    const before = Date.now();
    const t = parseFollowupDate('+1 dia')!;
    expect(t).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000 - 100);
  });

  it('aceita "+30min" / "+30 minutos"', () => {
    const before = Date.now();
    const a = parseFollowupDate('+30min')!;
    const b = parseFollowupDate('+30 minutos')!;
    expect(a).toBeGreaterThanOrEqual(before + 30 * 60 * 1000 - 100);
    expect(b).toBeGreaterThanOrEqual(before + 30 * 60 * 1000 - 100);
  });

  it('aceita "24h" sem +', () => {
    const before = Date.now();
    const t = parseFollowupDate('24h')!;
    expect(t).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000 - 100);
  });

  it('aceita "YYYY-MM-DD HH:MM" sem T (BRT)', () => {
    const t = parseFollowupDate('2026-05-08 14:00');
    expect(t).toBe(Date.UTC(2026, 4, 8, 17, 0, 0));
  });

  it('aceita "YYYY-MM-DD HH:MM:SS" sem T', () => {
    const t = parseFollowupDate('2026-05-08 14:30:45');
    expect(t).toBe(Date.UTC(2026, 4, 8, 17, 30, 45));
  });

  it('aceita BR sem zero-pad "8/5/2026"', () => {
    const t = parseFollowupDate('8/5/2026');
    expect(t).toBe(Date.UTC(2026, 4, 8, 17, 0, 0));
  });

  it('aceita BR sem zero-pad com hora "8/5/2026 9:30"', () => {
    const t = parseFollowupDate('8/5/2026 9:30');
    expect(t).toBe(Date.UTC(2026, 4, 8, 12, 30, 0));
  });

  it('continua null pra "amanhã" (texto natural não suportado)', () => {
    expect(parseFollowupDate('amanhã')).toBeNull();
    expect(parseFollowupDate('hoje à noite')).toBeNull();
  });
});
