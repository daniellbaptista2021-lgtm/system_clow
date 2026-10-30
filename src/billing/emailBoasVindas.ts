/**
 * E-mail de boas-vindas do EVOX (venda aprovada na Kiwify).
 *
 * HTML de e-mail: tabelas e estilo inline, porque Gmail e Outlook descartam
 * <style> e flexbox.
 * O logo é TEXTO (barras + EVOX), não imagem: o Gmail bloqueia toda imagem —
 * de fora ou embutida — em e-mail que caiu no spam (visto em 30/10/2026).
 */

const AZUL = '#0A66F5';
const TINTA = '#071221';
const CINZA = '#5B6678';
const FUNDO = '#F3F6FB';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function emailBoasVindas(o: { nome: string; plano: string; link: string; base: string }) {
  const primeiro = esc((o.nome || '').trim().split(/\s+/)[0] || '');
  const nomePlano = o.plano === 'completo' ? 'Completo' : 'Essencial';
  const site = o.base.replace(/^https?:\/\//, '');
  const link = esc(o.link);

  const passo = (n: number, titulo: string, texto: string) => `
          <tr>
            <td width="44" valign="top" style="padding:0 0 18px 0;">
              <div style="width:32px;height:32px;line-height:32px;border-radius:10px;background:#EAF2FF;color:${AZUL};font-weight:700;font-size:15px;text-align:center;">${n}</div>
            </td>
            <td valign="top" style="padding:0 0 18px 0;font-size:14px;line-height:21px;color:${CINZA};">
              <b style="color:${TINTA};font-size:15px;">${titulo}</b><br>${texto}
            </td>
          </tr>`;

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<title>Seu acesso ao EVOX</title>
</head>
<body style="margin:0;padding:0;background:${FUNDO};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Sua assinatura do EVOX foi confirmada. Crie sua senha e comece agora.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${FUNDO};">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;font-family:Inter,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

        <tr>
          <td align="center" style="padding:0 0 22px 0;">
            <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr>
              <td style="padding:0 10px 0 0;" valign="middle">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr><td style="width:30px;height:7px;font-size:0;line-height:0;background:#1CBEFF;border-radius:4px;">&nbsp;</td></tr>
                  <tr><td style="height:4px;font-size:0;line-height:0;">&nbsp;</td></tr>
                  <tr><td style="width:30px;height:7px;font-size:0;line-height:0;background:#0A66F5;border-radius:4px;">&nbsp;</td></tr>
                  <tr><td style="height:4px;font-size:0;line-height:0;">&nbsp;</td></tr>
                  <tr><td style="width:30px;height:7px;font-size:0;line-height:0;background:#004BCA;border-radius:4px;">&nbsp;</td></tr>
                </table>
              </td>
              <td valign="middle" style="font-family:Inter,'Segoe UI',Arial,sans-serif;font-size:34px;line-height:36px;font-weight:900;letter-spacing:4px;color:${TINTA};">EVO<span style="color:${AZUL};">X</span></td>
            </tr></table>
          </td>
        </tr>

        <tr>
          <td style="background:#FFFFFF;border-radius:20px;border:1px solid #E6EAF0;overflow:hidden;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="height:6px;line-height:6px;font-size:0;background:${AZUL};background-image:linear-gradient(90deg,#004BCA,#0A66F5 55%,#1CBEFF);border-radius:20px 20px 0 0;">&nbsp;</td></tr>
              <tr>
                <td style="padding:36px 36px 8px 36px;">
                  <div style="display:inline-block;padding:6px 12px;border-radius:999px;background:#EAF2FF;color:${AZUL};font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;">Plano ${nomePlano}</div>
                  <h1 style="margin:18px 0 10px 0;font-size:26px;line-height:32px;color:${TINTA};font-weight:800;letter-spacing:-.02em;">Bem-vindo ao EVOX${primeiro ? `, ${primeiro}` : ''}!</h1>
                  <p style="margin:0;font-size:16px;line-height:25px;color:${CINZA};">Sua assinatura foi confirmada. Falta só um passo: criar a sua senha para entrar no seu CRM.</p>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding:28px 36px 30px 36px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td align="center" style="border-radius:14px;background:${AZUL};box-shadow:0 8px 20px rgba(10,102,245,.30);">
                        <a href="${link}" target="_blank" style="display:inline-block;padding:16px 34px;font-size:16px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:14px;">Criar minha senha</a>
                      </td>
                    </tr>
                  </table>
                  <p style="margin:12px 0 0 0;font-size:12px;color:#8A94A6;">O link vale por 7 dias e funciona uma vez só.</p>
                </td>
              </tr>
              <tr><td style="padding:0 36px;"><div style="height:1px;background:#EEF1F6;line-height:1px;font-size:0;">&nbsp;</div></td></tr>
              <tr>
                <td style="padding:26px 36px 10px 36px;">
                  <p style="margin:0 0 18px 0;font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${AZUL};">Seus primeiros passos</p>
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    ${passo(1, 'Crie sua senha', 'Pelo botão acima, com pelo menos 8 caracteres.')}
                    ${passo(2, 'Entre no EVOX', `Em <a href="${esc(o.base)}" style="color:${AZUL};text-decoration:none;font-weight:600;">${esc(site)}</a>, com este e-mail e a senha que você criou.`)}
                    ${passo(3, 'Fale com o Agente IA', 'Conte como é a sua venda: ele monta o funil, os agentes do WhatsApp e o que mais você precisar.')}
                  </table>
                </td>
              </tr>
              <tr>
                <td style="padding:6px 36px 32px 36px;">
                  <p style="margin:0;font-size:12px;line-height:18px;color:#8A94A6;">O botão não abriu? Copie e cole no navegador:<br><a href="${link}" style="color:${AZUL};word-break:break-all;">${link}</a></p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td align="center" style="padding:22px 16px 0 16px;font-size:12px;line-height:18px;color:#8A94A6;">
            Você recebeu este e-mail porque assinou o EVOX, o CRM feito para corretores de seguros.<br>
            © ${new Date().getFullYear()} EVOX
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const text = `Bem-vindo ao EVOX${primeiro ? ', ' + primeiro : ''}!

Sua assinatura do EVOX (plano ${nomePlano}) foi confirmada.

Crie sua senha neste link (vale por 7 dias, uma vez só):
${o.link}

Seus primeiros passos:
1. Crie sua senha pelo link acima.
2. Entre em ${o.base} com este e-mail e a senha que você criou.
3. Fale com o Agente IA: ele monta o funil, os agentes do WhatsApp e o que mais você precisar.

EVOX — o CRM feito para corretores de seguros.`;

  return { subject: 'Seu acesso ao EVOX está pronto', html, text };
}
