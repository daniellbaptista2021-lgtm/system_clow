import { logger } from '../utils/logger.js';
/**
 * mailer.ts — Transactional email sender.
 *
 * Supports 2 backends (pick whichever is configured):
 *  1. SMTP (nodemailer) — via MAILER_SMTP_HOST etc
 *  2. Resend.com HTTP API — via MAILER_RESEND_API_KEY
 *  3. Sendgrid — via MAILER_SENDGRID_API_KEY
 *
 * Fallback: if none configured, logs the email body (dev mode) — never throws.
 */

interface EmailAttachment {
  filename: string;
  content: Buffer | string;
  contentType?: string;
}

interface EmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  attachments?: EmailAttachment[];
}

const FROM_NAME = process.env.MAILER_FROM_NAME || 'System Clow';
const FROM_EMAIL = process.env.MAILER_FROM_EMAIL || 'nao-responda@pvcorretor01.com.br';

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

export async function sendEmail(input: EmailInput): Promise<{ ok: boolean; id?: string; error?: string }> {
  const text = input.text || stripHtml(input.html);

  // Resend (HTTP API, simplest)
  if (process.env.MAILER_RESEND_API_KEY) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + process.env.MAILER_RESEND_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `${FROM_NAME} <${FROM_EMAIL}>`,
          to: [input.to],
          subject: input.subject,
          html: input.html,
          text,
        }),
      });
      const d: any = await r.json();
      if (!r.ok) return { ok: false, error: d?.message || `http_${r.status}` };
      return { ok: true, id: d.id };
    } catch (err: any) { return { ok: false, error: err.message }; }
  }

  // Sendgrid
  if (process.env.MAILER_SENDGRID_API_KEY) {
    try {
      const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + process.env.MAILER_SENDGRID_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: input.to }] }],
          from: { email: FROM_EMAIL, name: FROM_NAME },
          subject: input.subject,
          content: [
            { type: 'text/plain', value: text },
            { type: 'text/html', value: input.html },
          ],
        }),
      });
      if (!r.ok) return { ok: false, error: `sendgrid_http_${r.status}` };
      return { ok: true };
    } catch (err: any) { return { ok: false, error: err.message }; }
  }

  // SMTP via nodemailer (most generic)
  if (process.env.MAILER_SMTP_HOST) {
    try {
      const nm = await import('nodemailer');
      const transporter = nm.default.createTransport({
        host: process.env.MAILER_SMTP_HOST,
        port: parseInt(process.env.MAILER_SMTP_PORT || '587', 10),
        secure: process.env.MAILER_SMTP_SECURE === 'true',
        auth: {
          user: process.env.MAILER_SMTP_USER,
          pass: process.env.MAILER_SMTP_PASS,
        },
      });
      const info = await transporter.sendMail({
        from: `${FROM_NAME} <${FROM_EMAIL}>`,
        to: input.to,
        subject: input.subject,
        text, html: input.html,
        attachments: input.attachments?.map(a => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
        })),
      });
      return { ok: true, id: info.messageId };
    } catch (err: any) { return { ok: false, error: err.message }; }
  }

  // Fallback: persiste o email em disco como JSON pra que possa ser
  // inspecionado/encaminhado manualmente quando SMTP nao tiver configurado.
  // Pasta: data/pending-emails/<timestamp>__<safe-to>.json
  // Sem isso, conteudo do welcome email com a senha temp se perdia em log
  // truncado e o cliente ficava sem caminho. Agora fica preservado.
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.join(process.cwd(), 'data', 'pending-emails');
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeTo = input.to.replace(/[^a-zA-Z0-9@._-]/g, '_');
    const file = path.join(dir, `${ts}__${safeTo}.json`);
    const payload = {
      ts: new Date().toISOString(),
      to: input.to,
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      subject: input.subject,
      text,
      html: input.html,
      reason: 'no_mailer_backend_configured',
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8');
    logger.warn(`[mailer] sem backend SMTP/Resend/Sendgrid — salvo em disco: ${file}`);
  } catch (err: any) {
    logger.error('[mailer] fallback to disk falhou:', err?.message);
  }

  // Log resumido em paralelo (visibilidade rapida no pm2 logs)
  logger.info('\n━━━━━━━━━ EMAIL (no mailer configured — saved to disk) ━━━━━━━━━');
  logger.info('To:', input.to);
  logger.info('Subject:', input.subject);
  logger.info('Text:', text.slice(0, 200));
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  return { ok: false, error: 'no_mailer_configured' };
}

// ─── Templates ──────────────────────────────────────────────────────────
export async function sendWelcomeEmail(to: string, name: string, tempPassword: string, tier: string): Promise<void> {
  const tierLabel = ({
    starter: 'Starter',
    profissional: 'Profissional',
    empresarial: 'Empresarial',
    one: 'One',
    smart: 'Smart',
    business: 'Business',
  } as Record<string, string>)[tier] || tier;
  const tierMessages = ({
    empresarial: '8.000 mensagens IA/mês · 8 fluxos n8n · 50.000 contatos · 30 boards · 100 automações · 20 usuários · 10 canais WhatsApp',
    profissional: '3.000 mensagens IA/mês · 4 fluxos n8n · 5.000 contatos · 10 boards · 30 automações · 5 usuários · 3 canais WhatsApp',
    starter: '500 mensagens IA/mês · 1 fluxo n8n · 500 contatos · 2 boards · 5 automações · 1 canal WhatsApp',
  } as Record<string, string>)[tier] || '';
  const firstName = name.split(' ')[0] || name;
  const loginUrl = process.env.CLOW_PUBLIC_BASE_URL || 'https://system-clow.pvcorretor01.com.br';

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:0;background:#08081a;color:#E8E8F0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:600px;margin:0 auto;padding:32px 20px">

  <!-- LOGO + BRAND -->
  <div style="text-align:center;margin:0 0 28px">
    <div style="display:inline-flex;align-items:center;gap:10px">
      <div style="width:42px;height:42px;border-radius:12px;background:linear-gradient(135deg,#9B59FC,#4A9EFF);display:inline-flex;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(155,89,252,.4);vertical-align:middle">
        <span style="color:#fff;font-size:22px;font-weight:800;line-height:1">C</span>
      </div>
      <span style="font-size:18px;font-weight:700;color:#E8E8F0;letter-spacing:.3px;vertical-align:middle">System Clow</span>
    </div>
  </div>

  <div style="background:#0F0F24;border:1px solid rgba(155,89,252,.28);border-radius:18px;padding:36px 32px">

    <!-- HERO -->
    <h1 style="background:linear-gradient(135deg,#9B59FC,#4A9EFF);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;font-size:30px;margin:0 0 12px;letter-spacing:-.02em;font-weight:800;line-height:1.15">
      Bem-vindo, ${firstName}! 🎉
    </h1>
    <p style="color:#B8B8D0;line-height:1.65;font-size:15.5px;margin:0 0 26px">
      Sua assinatura tá <strong style="color:#22C55E">ativa</strong> e a IA já tá pronta pra trabalhar pra você.
      Bora fazer seu primeiro lead virar venda hoje?
    </p>

    <!-- PLAN BADGE -->
    <div style="background:linear-gradient(135deg,rgba(155,89,252,.12),rgba(74,158,255,.08));border:1px solid rgba(155,89,252,.28);border-radius:12px;padding:18px 20px;margin:0 0 22px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div>
          <div style="font-size:11px;color:#9898B8;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:3px">Seu plano</div>
          <div style="font-size:20px;color:#E8E8F0;font-weight:700">${tierLabel}</div>
        </div>
        <div style="background:rgba(34,197,94,.15);border:1px solid rgba(34,197,94,.35);color:#22C55E;font-size:11px;font-weight:700;padding:5px 12px;border-radius:99px;text-transform:uppercase;letter-spacing:.5px">Ativo</div>
      </div>
      ${tierMessages ? `<div style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(155,89,252,.18);color:#B8B8D0;font-size:12.5px;line-height:1.55">${tierMessages}</div>` : ''}
    </div>

    <!-- CREDENTIALS -->
    <div style="background:#14142A;border:1px solid rgba(155,89,252,.18);border-radius:12px;padding:20px;margin:0 0 14px">
      <div style="font-size:11px;color:#9898B8;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:6px">📧 Email de login</div>
      <div style="font-size:15px;color:#E8E8F0;font-family:'SF Mono',Consolas,Monaco,monospace;margin-bottom:18px;word-break:break-all">${to}</div>
      <div style="font-size:11px;color:#9898B8;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:6px">🔑 Senha temporária</div>
      <div style="display:inline-block;background:rgba(155,89,252,.18);border:1px dashed rgba(155,89,252,.45);padding:10px 16px;border-radius:8px;font-family:'SF Mono',Consolas,Monaco,monospace;font-size:18px;color:#E8E8F0;font-weight:600;letter-spacing:1px">${tempPassword}</div>
    </div>
    <p style="color:#F59E0B;font-size:12.5px;line-height:1.55;margin:0 0 24px">
      ⚠️ <strong>Troque essa senha logo depois do primeiro login</strong> em Configurações → Segurança.
    </p>

    <!-- CTA PRIMARY -->
    <div style="text-align:center;margin:0 0 30px">
      <a href="${loginUrl}/" style="display:inline-block;background:linear-gradient(135deg,#9B59FC,#4A9EFF);color:#fff;text-decoration:none;padding:15px 36px;border-radius:12px;font-weight:700;font-size:15px;box-shadow:0 8px 20px rgba(155,89,252,.35)">
        Entrar agora →
      </a>
      <div style="margin-top:10px;font-size:12px;color:#6E6E8C">
        ${loginUrl}
      </div>
    </div>

    <!-- HOW TO USE -->
    <div style="margin:30px 0 0;padding:24px 0 0;border-top:1px solid rgba(255,255,255,.08)">
      <h2 style="color:#E8E8F0;font-size:18px;margin:0 0 18px;font-weight:700">🚀 Primeiros passos (5 min)</h2>

      <div style="margin:0 0 16px">
        <div style="color:#9B59FC;font-size:12px;font-weight:700;margin-bottom:4px;letter-spacing:.5px">PASSO 1 — LOGIN</div>
        <div style="color:#B8B8D0;font-size:14px;line-height:1.5">Acessa <a href="${loginUrl}/" style="color:#4A9EFF;text-decoration:none">${loginUrl}</a> com o email e a senha temporária acima. Troca a senha em Configurações.</div>
      </div>

      <div style="margin:0 0 16px">
        <div style="color:#9B59FC;font-size:12px;font-weight:700;margin-bottom:4px;letter-spacing:.5px">PASSO 2 — CONECTA SEU WHATSAPP</div>
        <div style="color:#B8B8D0;font-size:14px;line-height:1.5">No menu CRM → <strong>Canais WA</strong>. Você escolhe entre Meta WhatsApp Business (oficial, paga API) ou Z-API (mais barato, escaneia QR no celular). A IA atende teus clientes 24/7 a partir desse momento.</div>
      </div>

      <div style="margin:0 0 16px">
        <div style="color:#9B59FC;font-size:12px;font-weight:700;margin-bottom:4px;letter-spacing:.5px">PASSO 3 — INSTALA NO CELULAR (PWA, opcional)</div>
        <div style="color:#B8B8D0;font-size:14px;line-height:1.5">
          O System Clow funciona como app nativo — sem precisar baixar da Play Store/App Store.
          <ul style="padding-left:20px;margin:8px 0 0;color:#B8B8D0">
            <li><strong>Android (Chrome):</strong> abre o site → menu ⋮ → "Instalar app" ou "Adicionar à tela inicial"</li>
            <li><strong>iPhone (Safari):</strong> abre o site → botão Compartilhar → "Adicionar à Tela de Início"</li>
            <li><strong>Desktop:</strong> Chrome/Edge mostram um ícone de instalação na barra de endereço</li>
          </ul>
        </div>
      </div>

      <div style="margin:0">
        <div style="color:#9B59FC;font-size:12px;font-weight:700;margin-bottom:4px;letter-spacing:.5px">PASSO 4 — IMPORTA TEUS CONTATOS (opcional)</div>
        <div style="color:#B8B8D0;font-size:14px;line-height:1.5">CRM → Contatos → Importar CSV. Aceita o formato padrão de qualquer CRM (Pipedrive, RD Station, planilha do Excel).</div>
      </div>
    </div>

    <!-- DICA -->
    <div style="background:rgba(74,158,255,.08);border-left:3px solid #4A9EFF;border-radius:6px;padding:14px 16px;margin:24px 0 0">
      <div style="color:#4A9EFF;font-size:12px;font-weight:700;margin-bottom:4px">💡 DICA</div>
      <div style="color:#B8B8D0;font-size:13.5px;line-height:1.55">A IA aprende com cada conversa. Nas primeiras 24h ela tá calibrando seu tom de voz, gírias e padrão de qualificação. Não estranha se a primeira resposta parecer genérica — em um dia ela tá com a tua cara.</div>
    </div>

    <!-- SUPPORT -->
    <hr style="border:0;border-top:1px solid rgba(255,255,255,.08);margin:30px 0 22px">
    <div style="color:#9898B8;font-size:13px;line-height:1.6">
      <strong style="color:#E8E8F0">Precisa de ajuda?</strong><br>
      Responde direto neste email — chega no time de suporte e a gente responde no mesmo dia útil.
    </div>

  </div>

  <!-- FOOTER -->
  <div style="text-align:center;color:#6E6E8C;font-size:11px;margin-top:24px;line-height:1.6">
    System Clow © 2026 · IA pra corretores de imóveis<br>
    <a href="${loginUrl}" style="color:#6E6E8C;text-decoration:none">${loginUrl.replace(/^https?:\/\//, '')}</a>
  </div>
</div>
</body></html>`;
  await sendEmail({ to, subject: `Bem-vindo ao System Clow, ${firstName}! Sua assinatura ${tierLabel} tá ativa 🎉`, html });
}

export async function sendPasswordResetEmail(to: string, name: string, resetUrl: string): Promise<void> {
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#08081a;color:#E8E8F0;font-family:system-ui,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:40px 24px">
  <div style="background:#0F0F24;border:1px solid rgba(155,89,252,.28);border-radius:16px;padding:36px">
    <h1 style="font-size:22px;margin:0 0 14px">Redefinir senha</h1>
    <p style="color:#B8B8D0;line-height:1.6">Olá ${name.split(' ')[0]}, clica no link abaixo pra redefinir sua senha (expira em 1 hora):</p>
    <a href="${resetUrl}" style="display:inline-block;background:linear-gradient(135deg,#9B59FC,#4A9EFF);color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-weight:700;margin:20px 0">Redefinir senha</a>
    <p style="color:#6E6E8C;font-size:12px">Se você não solicitou, ignore esse email.</p>
  </div>
</div></body></html>`;
  await sendEmail({ to, subject: 'System Clow — Redefinir senha', html });
}
