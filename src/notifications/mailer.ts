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

interface EmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
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
      });
      return { ok: true, id: info.messageId };
    } catch (err: any) { return { ok: false, error: err.message }; }
  }

  // Dev fallback: log only
  console.log('\n━━━━━━━━━ EMAIL (dev mode — not sent) ━━━━━━━━━');
  console.log('To:', input.to);
  console.log('Subject:', input.subject);
  console.log('Text:', text.slice(0, 400));
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  return { ok: false, error: 'no_mailer_configured' };
}

// ─── Templates ──────────────────────────────────────────────────────────
export async function sendWelcomeEmail(to: string, name: string, tempPassword: string, tier: string): Promise<void> {
  const tierLabel = { starter: 'Starter', profissional: 'Profissional', empresarial: 'Empresarial' }[tier] || tier;
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#08081a;color:#E8E8F0;font-family:system-ui,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:40px 24px">
  <div style="background:#0F0F24;border:1px solid rgba(155,89,252,.28);border-radius:16px;padding:36px">
    <h1 style="background:linear-gradient(135deg,#9B59FC,#4A9EFF);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;font-size:26px;margin:0 0 14px">Bem-vindo ao System Clow, ${name.split(' ')[0]}!</h1>
    <p style="color:#B8B8D0;line-height:1.6;margin:0 0 20px">Sua conta foi criada com sucesso no plano <strong style="color:#E8E8F0">${tierLabel}</strong>. Use os dados abaixo para fazer login:</p>
    <div style="background:#14142A;border:1px solid rgba(155,89,252,.18);border-radius:10px;padding:18px;margin:0 0 24px">
      <div style="font-size:12px;color:#9898B8;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Email</div>
      <div style="font-size:15px;color:#E8E8F0;font-family:monospace;margin-bottom:14px">${to}</div>
      <div style="font-size:12px;color:#9898B8;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Senha temporária</div>
      <div style="font-size:15px;color:#E8E8F0;font-family:monospace;background:rgba(155,89,252,.15);display:inline-block;padding:6px 12px;border-radius:6px">${tempPassword}</div>
    </div>
    <p style="color:#9898B8;font-size:13px;line-height:1.6;margin:0 0 24px"><strong style="color:#F59E0B">Importante:</strong> troque sua senha depois do primeiro login em Configurações.</p>
    <a href="https://system-clow.pvcorretor01.com.br/" style="display:inline-block;background:linear-gradient(135deg,#9B59FC,#4A9EFF);color:#fff;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:700">Entrar no System Clow →</a>
    <hr style="border:0;border-top:1px solid rgba(255,255,255,.08);margin:32px 0">
    <p style="color:#6E6E8C;font-size:12px;line-height:1.6;margin:0">
      Depois de logar, vai lá em <strong>Canais WA</strong> no CRM e conecta teu WhatsApp (Meta oficial ou Z-API — você escolhe).
      A IA já tá pronta pra atender teus clientes 24/7.<br><br>
      Dúvidas? Responde esse email.
    </p>
  </div>
  <div style="text-align:center;color:#6E6E8C;font-size:11px;margin-top:24px">System Clow © 2026</div>
</div>
</body></html>`;
  await sendEmail({ to, subject: 'Bem-vindo ao System Clow — Credenciais de acesso', html });
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
