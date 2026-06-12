#!/usr/bin/env node
/**
 * preview-welcome-email.cjs — renderiza o welcome email num HTML standalone.
 * Gera docs/sample-welcome-email.html — abre no navegador pra ver como
 * vai chegar pro cliente assinante (sem precisar de mailer configurado).
 *
 * Uso: node scripts/preview-welcome-email.cjs [tier]
 *      tier default = empresarial. Aceita: starter, profissional, empresarial.
 *
 * Reads dist/notifications/mailer.js, extracts the HTML template literal
 * inside sendWelcomeEmail, and renders it with sample inputs. Não duplica
 * código de produção — usa exatamente o mesmo template fonte.
 */
const fs = require('node:fs');
const path = require('node:path');

const TIER = process.argv[2] || 'empresarial';
const TO = 'daniellbaptista2021@gmail.com';
const NAME = 'Daniel Baptista';
const TEMP_PASSWORD = 'BC6m0Cqfcqau';

// Extrai o html template do mailer.js compilado e renderiza com nossos valores.
const mailerSource = fs.readFileSync(
  path.resolve(__dirname, '..', 'dist', 'notifications', 'mailer.js'),
  'utf-8',
);

// Encontra o trecho `const html = \`...\`;` dentro de sendWelcomeEmail.
const htmlStart = mailerSource.indexOf('const html = `', mailerSource.indexOf('sendWelcomeEmail'));
if (htmlStart === -1) throw new Error('não encontrei const html = `... no mailer.js compilado');
const tickStart = htmlStart + 'const html = '.length; // posição da crase de abertura
const tickEnd = mailerSource.indexOf('`;', tickStart + 1);
if (tickEnd === -1) throw new Error('não encontrei fim do template literal');
const templateLiteral = mailerSource.slice(tickStart, tickEnd + 1); // inclui a crase final

// Avalia o template com closure das variáveis que ele referencia.
const tierLabel = ({
  starter: 'Starter',
  profissional: 'Profissional',
  empresarial: 'Empresarial',
  one: 'One',
  smart: 'Smart',
  business: 'Business',
})[TIER] || TIER;
const tierMessages = ({
  empresarial: '8.000 mensagens IA/mês · 8 fluxos n8n · 50.000 contatos · 30 boards · 100 automações · 20 usuários · 10 canais WhatsApp',
  profissional: '3.000 mensagens IA/mês · 4 fluxos n8n · 5.000 contatos · 10 boards · 30 automações · 5 usuários · 3 canais WhatsApp',
  starter: '500 mensagens IA/mês · 1 fluxo n8n · 500 contatos · 2 boards · 5 automações · 1 canal WhatsApp',
})[TIER] || '';
const firstName = NAME.split(' ')[0] || NAME;
const loginUrl = process.env.CLOW_PUBLIC_BASE_URL || 'https://system-clow.pvcorretor01.com.br';
const to = TO;
const tempPassword = TEMP_PASSWORD;

// Avalia o template literal SEM eval direto. Usa Function constructor com
// as variáveis no escopo. Mesmo assim é trusted source (nosso código).
// eslint-disable-next-line no-new-func
const renderFn = new Function(
  'tierLabel', 'tierMessages', 'firstName', 'loginUrl', 'to', 'tempPassword',
  `return ${templateLiteral};`,
);
const html = renderFn(tierLabel, tierMessages, firstName, loginUrl, to, tempPassword);

const outDir = path.resolve(__dirname, '..', 'docs');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'sample-welcome-email.html');
fs.writeFileSync(outPath, html);

console.log(`subject: Bem-vindo ao System Clow, ${firstName}! Sua assinatura ${tierLabel} tá ativa 🎉`);
console.log(`to:      ${to}`);
console.log(`tier:    ${tierLabel}`);
console.log(`saved:   ${outPath} (${html.length} bytes)`);
console.log(`open in browser: file://${outPath.replace(/\\/g, '/')}`);
