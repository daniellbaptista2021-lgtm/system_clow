import { describe, expect, it } from 'vitest';
import { normalizarNomePerfil } from '../../src/tenancy/perfil.js';

describe('nome exibido no perfil', () => {
  it('limpa espaços e aceita o nome do Daniel', () => {
    expect(normalizarNomePerfil('  Daniel   Baptista  ')).toBe('Daniel Baptista');
  });

  it('recusa nome vazio, curto ou grande demais', () => {
    expect(normalizarNomePerfil('  ')).toBeNull();
    expect(normalizarNomePerfil('AB')).toBeNull();
    expect(normalizarNomePerfil('x'.repeat(81))).toBeNull();
  });
});
