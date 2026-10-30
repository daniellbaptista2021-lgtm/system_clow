/** Lembrete de mensalidade: cada etapa (3 dias, 1 dia, no dia) sai uma vez só. */
import { describe, it, expect } from 'vitest';
import { etapaDoLembrete, deveLembrar } from '../../src/crm/billing.js';

const H = 3600_000, D = 24 * H;
const agora = Date.UTC(2026, 9, 30, 12); // 9h em Brasília

describe('lembrete de mensalidade', () => {
  it('escolhe a etapa mais próxima do vencimento', () => {
    expect(etapaDoLembrete(agora + 5 * D, agora)).toBe(-1);
    expect(etapaDoLembrete(agora + 3 * D, agora)).toBe(0);
    expect(etapaDoLembrete(agora + 2 * D, agora)).toBe(0);
    expect(etapaDoLembrete(agora + 1 * D, agora)).toBe(1);
    expect(etapaDoLembrete(agora + 3 * H, agora)).toBe(2); // hoje, ao meio-dia
    expect(etapaDoLembrete(agora - D, agora)).toBe(-1);
  });

  it('"vence amanhã" não sai de novo a cada minuto (era 3× seguidas)', () => {
    const etapa = etapaDoLembrete(agora + D, agora);
    expect(deveLembrar(0, etapa)).toBe(true);
    // depois do primeiro envio reminders_sent vira etapa + 1
    expect(deveLembrar(etapa + 1, etapaDoLembrete(agora + D - 60_000, agora))).toBe(false);
    expect(deveLembrar(etapa + 1, etapaDoLembrete(agora + D - 3 * H, agora))).toBe(false);
  });

  it('dias de calendário de Brasília, não horas', async () => {
    const { diasAteVencer } = await import('../../src/crm/billing.js');
    // 23h de Brasília → vence 1h depois (já é amanhã no calendário)
    const noite = Date.UTC(2026, 9, 31, 2);
    expect(diasAteVencer(noite + 2 * H, noite)).toBe(1);
    expect(diasAteVencer(agora + 2 * D, agora)).toBe(2);
  });

  it('assinatura criada a 1 dia do vencimento não recebe o "em 3 dias"', () => {
    expect(etapaDoLembrete(agora + D, agora)).toBe(1);
  });

  it('servidor desligado na hora certa: a etapa sai quando ele volta', () => {
    // a janela de T-1 era ±30 min; agora vale o dia inteiro de "amanhã"
    expect(deveLembrar(1, etapaDoLembrete(agora + D + 8 * H, agora))).toBe(true);
  });
});
