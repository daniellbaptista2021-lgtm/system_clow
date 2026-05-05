import { describe, it, expect } from 'vitest';
import { maskPhone, maskEmail, maskDoc } from '../../src/utils/redact.js';

describe('maskPhone', () => {
  it('mascara telefone BR completo (13 digitos: 55+DDD+9digitos)', () => {
    expect(maskPhone('5521990423520')).toBe('5521****3520');
  });
  it('mascara com sinal de +', () => {
    expect(maskPhone('+5521990423520')).toBe('+5521****3520');
  });
  it('mascara DDD+numero (11 digitos)', () => {
    expect(maskPhone('21990423520')).toBe('2199****3520');
  });
  it('aceita null/undefined retornando string vazia', () => {
    expect(maskPhone(null)).toBe('');
    expect(maskPhone(undefined)).toBe('');
    expect(maskPhone('')).toBe('');
  });
  it('telefone curto demais: mascara quase tudo', () => {
    expect(maskPhone('1234')).toBe('**34');
    expect(maskPhone('12')).toBe('**');
  });
  it('aceita formatado (mantem so digitos)', () => {
    expect(maskPhone('(21) 99042-3520')).toBe('2199****3520');
  });
  it('NAO contem o numero completo na saida', () => {
    const masked = maskPhone('5521990423520');
    expect(masked).not.toContain('99042');
    expect(masked).not.toContain('990423520');
  });
});

describe('maskEmail', () => {
  it('mascara local-part preservando dominio', () => {
    expect(maskEmail('daniellbaptista2021@gmail.com')).toBe('d***@gmail.com');
  });
  it('email curto', () => {
    expect(maskEmail('ab@example.com')).toBe('a***@example.com');
  });
  it('null/undefined', () => {
    expect(maskEmail(null)).toBe('');
    expect(maskEmail(undefined)).toBe('');
  });
  it('sem @ retorna mascara generica', () => {
    expect(maskEmail('semarroba')).toBe('***');
  });
});

describe('maskDoc', () => {
  it('mascara CPF preservando 2 ultimos', () => {
    expect(maskDoc('12345678901')).toBe('*********01');
  });
  it('mascara CPF com pontuacao', () => {
    expect(maskDoc('123.456.789-01')).toBe('*********01');
  });
  it('null/empty', () => {
    expect(maskDoc(null)).toBe('');
    expect(maskDoc('')).toBe('');
  });
});
