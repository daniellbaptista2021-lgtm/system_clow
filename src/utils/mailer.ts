/**
 * mailer.ts — abstracao de envio de email com 3 backends transparentes:
 *
 *   1. Resend  — se RESEND_API_KEY setado (https://resend.com — 3000/mes free)
 *   2. SMTP    — se SMTP_HOST setado (Brevo, Sendgrid, AWS SES, qualquer provider)
 *   3. Logger  — fallback dev: imprime o conteudo do email no log (Daniel ainda
 *                consegue copiar o link de verificacao do output do PM2)
 *
 * Sempre retorna sem throw — falha de email NAO derruba o signup. Loga
 * warning e retorna { ok: false, reason }. Caller decide se exibe pro user
 * "fallback de e-mail nao disponivel agora" ou nao.
 */

import { logger } from './logger.js';
import { maskEmail } from './redact.js';

export interface SendMailParams {
  to: string;
  subject: string;
  text: string;       // plain text (obrigatorio)
  html?: string;      // opcional, fallback pro text
  from?: string;      // override
}

export interface SendMailResult {
  ok: boolean;
  backend: 'resend' | 'smtp' | 'logger' | 'none';
  reason?: string;
  messageId?: string;
}

const DEFAULT_FROM = process.env.CLOW_MAIL_FROM || 'no-reply@system-clow.pvcorretor01.com.br';

/**
 * Envia email pelo melhor backend disponivel. Nunca throw.
 */
export async function sendMail(params: SendMailParams): Promise<SendMailResult> {
  const { to, subject, text, html, from } = params;
  if (!to || !subject || !text) {
    return { ok: false, backend: 'none', reason: 'missing_fields' };
  }

  // 1) Resend (primeira escolha — API simples + free tier generoso)
  if (process.env.RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: from || DEFAULT_FROM,
          to: [to],
          subject,
          text,
          html: html || undefined,
        }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({})) as any;
        logger.info(`[mailer.resend] sent to=${maskEmail(to)} subject="${subject.slice(0, 40)}" id=${data.id ?? '?'}`);
        return { ok: true, backend: 'resend', messageId: data.id };
      } else {
        const err = await res.text();
        logger.warn(`[mailer.resend] HTTP ${res.status}: ${err.slice(0, 200)}`);
        return { ok: false, backend: 'resend', reason: `http_${res.status}` };
      }
    } catch (err: any) {
      logger.warn('[mailer.resend] erro:', err?.message);
      return { ok: false, backend: 'resend', reason: err?.message };
    }
  }

  // 2) SMTP (nodemailer) — so importa se realmente for usar
  if (process.env.SMTP_HOST) {
    try {
      const nodemailer = (await import('nodemailer' as any)).default ?? await import('nodemailer' as any);
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER ? {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        } : undefined,
      });
      const info = await transporter.sendMail({
        from: from || DEFAULT_FROM,
        to,
        subject,
        text,
        html,
      });
      logger.info(`[mailer.smtp] sent to=${maskEmail(to)} id=${info.messageId}`);
      return { ok: true, backend: 'smtp', messageId: info.messageId };
    } catch (err: any) {
      logger.warn('[mailer.smtp] erro:', err?.message);
      return { ok: false, backend: 'smtp', reason: err?.message };
    }
  }

  // 3) Logger fallback — printa no log (DEV only — em prod isso e bug)
  logger.warn(
    `[mailer.logger] EMAIL NAO ENVIADO (configurar RESEND_API_KEY ou SMTP_HOST). Conteudo:\n` +
    `  to: ${maskEmail(to)}\n` +
    `  subject: ${subject}\n` +
    `  text: ${text.slice(0, 500)}${text.length > 500 ? '...' : ''}`,
  );
  return { ok: false, backend: 'logger', reason: 'no_provider_configured' };
}
