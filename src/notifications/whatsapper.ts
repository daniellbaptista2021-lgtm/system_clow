/**
 * whatsapper.ts — Transactional WhatsApp sender (Meta Cloud API).
 *
 * Uso: enviar credenciais/boas-vindas após pagamento Stripe.
 *
 * Limitação Meta: fora da janela de 24h a partir da última msg inbound,
 * só conseguimos mandar TEMPLATE aprovado. Cliente novo = sempre template.
 *
 * Como aprovar template (uma vez, no Meta Business Manager):
 *   1. https://business.facebook.com → WhatsApp Manager → Message Templates
 *   2. Criar template categoria UTILITY:
 *      - name: clow_welcome
 *      - language: pt_BR
 *      - header: "Bem-vindo ao System Clow!"
 *      - body: "Olá {{1}}! Seu plano {{2}} tá ativo.
 *               Senha temporária: *{{3}}*
 *               Faça login: {{4}}
 *               Troque a senha no primeiro acesso."
 *      - variables: 1=nome, 2=plano, 3=senha_temp, 4=link_login
 *   3. Aguardar aprovação (geralmente < 1h pra UTILITY)
 *   4. Setar env: META_WA_TEMPLATE_WELCOME=clow_welcome
 *
 * Se template não configurado ou falhar, tenta freeform (funciona se
 * cliente já mandou msg pro nosso número nos últimos 24h — raro, mas
 * deixa como best-effort). Nunca lança exceção — email é o canal primário.
 */

const API_VERSION = process.env.META_WA_API_VERSION || 'v22.0';

function metaConfig() {
  const token = process.env.META_WA_ACCESS_TOKEN;
  const phoneNumberId = process.env.META_WA_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) return null;
  return { token, phoneNumberId };
}

// E.164 normalize: "21 99999-8888" → "5521999998888"; "+5511..." → "5511..."
function normalizeBR(raw: string): string {
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('55') && digits.length >= 12) return digits;
  if (digits.length === 10 || digits.length === 11) return '55' + digits;
  return digits;
}

async function fetchWithTimeout(url: string, opts: any, ms = 10000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally { clearTimeout(t); }
}

/**
 * Envia template pré-aprovado pelo Meta.
 * Para templates AUTHENTICATION com OTP button (COPY_CODE), use withOtpButton=true
 * — nesse caso bodyVars deve ter exatamente 1 item (o código) e o botão replica ele.
 */
export async function sendTemplate(params: {
  toPhone: string;
  templateName: string;
  languageCode?: string;
  bodyVars?: string[]; // valores para {{1}}, {{2}}, ...
  withOtpButton?: boolean; // true pra authentication template com COPY_CODE
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const cfg = metaConfig();
  if (!cfg) return { ok: false, error: 'meta_not_configured' };

  const to = normalizeBR(params.toPhone);
  if (!to) return { ok: false, error: 'invalid_phone' };

  const body: any = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: params.templateName,
      language: { code: params.languageCode || 'pt_BR' },
    },
  };

  const components: any[] = [];
  if (params.bodyVars && params.bodyVars.length) {
    components.push({
      type: 'body',
      parameters: params.bodyVars.map(v => ({ type: 'text', text: String(v) })),
    });
  }
  if (params.withOtpButton && params.bodyVars && params.bodyVars.length > 0) {
    // OTP COPY_CODE: button param mirrors the code from body
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: String(params.bodyVars[0]) }],
    });
  }
  if (components.length) body.template.components = components;

  try {
    const res = await fetchWithTimeout(
      `https://graph.facebook.com/${API_VERSION}/${cfg.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.token}`,
        },
        body: JSON.stringify(body),
      }
    );
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: data?.error?.message || `http_${res.status}` };
    }
    return { ok: true, messageId: data?.messages?.[0]?.id };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'fetch_error' };
  }
}

/**
 * Envia texto livre — só funciona dentro da janela de 24h.
 * Best-effort: se Meta rejeitar por "outside session window", loga e segue.
 */
export async function sendFreeform(toPhone: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const cfg = metaConfig();
  if (!cfg) return { ok: false, error: 'meta_not_configured' };

  const to = normalizeBR(toPhone);
  if (!to) return { ok: false, error: 'invalid_phone' };

  try {
    const res = await fetchWithTimeout(
      `https://graph.facebook.com/${API_VERSION}/${cfg.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.token}`,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { preview_url: true, body: text },
        }),
      }
    );
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.error?.message || `http_${res.status}` };
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'fetch_error' };
  }
}

/**
 * Mandar credenciais de boas-vindas.
 * 1. Tenta template (env: META_WA_TEMPLATE_WELCOME, padrão: clow_welcome)
 * 2. Se falhar, tenta freeform (só vai pegar se janela de 24h estiver aberta)
 * 3. Nunca lança — email é o canal primário.
 */
export async function sendWelcomeWhatsApp(
  toPhone: string,
  fullName: string,
  tempPassword: string,
  plan: string,
  loginUrl?: string,
): Promise<{ ok: boolean; via?: 'template' | 'freeform'; error?: string }> {
  const cfg = metaConfig();
  if (!cfg) {
    console.warn('[wa-welcome] Meta não configurado — pulando WhatsApp');
    return { ok: false, error: 'meta_not_configured' };
  }

  const firstName = String(fullName || '').trim().split(/\s+/)[0] || 'você';
  const link = loginUrl || process.env.CLOW_PUBLIC_BASE_URL || 'https://system-clow.pvcorretor01.com.br';

  // Template AUTHENTICATION approved at Meta: clow_access_code
  // Estrutura fixa: body com variável única {{1}} = senha, + botão COPY_CODE que replica {{1}}.
  // Meta gera o texto: "{{1}} é o seu código de verificação. Por sua segurança, não compartilhe."
  // Permite override via env caso use outro template aprovado.
  const templateName = process.env.META_WA_TEMPLATE_WELCOME || 'clow_access_code';

  // 1. Tenta template authentication (só a senha como variável)
  const tmpl = await sendTemplate({
    toPhone,
    templateName,
    languageCode: 'pt_BR',
    bodyVars: [tempPassword],
    withOtpButton: true,
  });
  if (tmpl.ok) {
    console.log(`[wa-welcome] template "${templateName}" enviado pra ${toPhone} (id=${tmpl.messageId})`);
    return { ok: true, via: 'template' };
  }

  console.warn(`[wa-welcome] template "${templateName}" falhou: ${tmpl.error} — tentando freeform`);

  // 2. Fallback freeform (só funciona dentro da janela 24h)
  const body = [
    `🎉 Bem-vindo ao *System Clow*, ${firstName}!`,
    ``,
    `Seu plano *${plan}* tá ativo.`,
    ``,
    `🔑 Senha temporária: \`${tempPassword}\``,
    `🔗 Acesso: ${link}`,
    ``,
    `Troque a senha no primeiro acesso. Qualquer dúvida, responde aqui.`,
  ].join('\n');
  const fb = await sendFreeform(toPhone, body);
  if (fb.ok) {
    console.log(`[wa-welcome] freeform enviado pra ${toPhone} (janela 24h aberta)`);
    return { ok: true, via: 'freeform' };
  }

  console.warn(`[wa-welcome] freeform tb falhou: ${fb.error} — email continua como canal primário`);
  return { ok: false, error: fb.error };
}
