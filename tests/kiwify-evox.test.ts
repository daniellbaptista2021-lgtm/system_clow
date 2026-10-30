/** Kiwify → EVOX: plano pelo link, produto de outro sistema ignorado, ação por evento. */
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { lerVenda, acaoDaVenda, validarKiwify, ehDeOutraAssinatura } from '../src/billing/kiwifyEvox.js';

const venda = (extra: any = {}) => ({
  webhook_event_type: 'order_approved', order_id: 'o1', subscription_id: 's1', checkout_link: 'u2MmyBH',
  Product: { product_name: 'EVOX' }, Customer: { email: 'Ana@Exemplo.com', full_name: 'Ana Souza', mobile: '5511999990000' },
  Subscription: { plan: { name: 'EVOX Completo' } }, ...extra,
});

describe('kiwify → evox', () => {
  it('plano pelo código do link de checkout', () => {
    expect(lerVenda(venda()).plano).toBe('completo');
    expect(lerVenda(venda({ checkout_link: 'qp9Xp4v', Subscription: {} })).plano).toBe('essencial');
    expect(lerVenda(venda()).email).toBe('ana@exemplo.com');
  });
  it('venda do Território Próprio não vira conta no EVOX', () => {
    const v = lerVenda(venda({ checkout_link: 'jE3DNt8', Product: { product_name: 'Territorio Proprio' }, Subscription: { plan: { name: 'Território Próprio' } } }));
    expect(v.ehEvox).toBe(false);
  });
  it('ações por evento', () => {
    expect(acaoDaVenda(lerVenda(venda()))).toBe('liberar');
    expect(acaoDaVenda(lerVenda(venda({ webhook_event_type: 'subscription_renewed' })))).toBe('liberar');
    expect(acaoDaVenda(lerVenda(venda({ webhook_event_type: 'subscription_canceled' })))).toBe('encerrar');
    expect(acaoDaVenda(lerVenda(venda({ webhook_event_type: 'order_refunded' })))).toBe('encerrar');
    expect(acaoDaVenda(lerVenda(venda({ webhook_event_type: 'chargeback' })))).toBe('encerrar');
    expect(acaoDaVenda(lerVenda(venda({ webhook_event_type: 'subscription_late' })))).toBe('registrar');
  });
  it('assinatura: HMAC sha1 na URL, token no corpo; errado recusa', () => {
    const corpo = JSON.stringify(venda({ token: 'tok123' }));
    const sig = crypto.createHmac('sha1', 'tok123').update(corpo).digest('hex');
    expect(validarKiwify(corpo, sig, null, 'tok123')).toBe('hmac-sha1');
    expect(validarKiwify(corpo, null, null, 'tok123')).toBe('token-corpo');
    expect(validarKiwify(corpo, 'abc', null, 'tok123')).toBeNull();
    expect(validarKiwify(JSON.stringify(venda()), null, null, 'tok123')).toBeNull();
  });
  it('aviso de outra assinatura não encerra a atual', () => {
    expect(ehDeOutraAssinatura('s1', lerVenda(venda({ webhook_event_type: 'subscription_canceled' })))).toBe(false);
    expect(ehDeOutraAssinatura('s-nova', lerVenda(venda({ webhook_event_type: 'subscription_canceled' })))).toBe(true);
  });
});
