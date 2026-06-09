# Deploy das melhorias de 2026-06 (branch `claude/friendly-galileo-10cebi`)

## O que mudou

### Corretude (multi-worker / PM2 cluster)
- **Lock de execução por card** (`crm:col-agent:card:{tenantId}:{cardId}`): um fire
  de inatividade e uma mensagem inbound do mesmo card não rodam mais o tool
  loop em paralelo (eliminava promoção dupla e `turnsCount` corrompido).
  Mensagem inbound **nunca é descartada**: espera o lock até 45s e, no pior
  caso, degrada pro comportamento antigo.
- **Lock de mensagem escopado por tenant**: `crm:col-agent:msg:{tenantId}:{messageId}`.
- **Promoção de card em transação única** (move + reset de timestamps + state):
  falha em qualquer passo desfaz tudo — antes, crash no meio deixava card e
  state em colunas diferentes.
- `ClusterStore` ganhou `del(key)` (release de lock antes do TTL).

### Segurança
- **`/webhooks/asaas` fail-closed**: sem `ASAAS_WEBHOOK_TOKEN` no `.env`, o
  endpoint rejeita tudo com 503 (antes aceitava qualquer POST). **Ação
  necessária se você usa Asaas** — ver checklist abaixo.
- **Sandbox bash bloqueia `ssh`/`scp`/`sftp`** para tenants (pivot de rede
  usando o IP do servidor). Admin não é afetado.
- **License token via query string (`?license=`)**: ainda funciona, mas loga
  aviso de deprecação — migrar clientes pro header `x-license-token`.
- **Senha admin em texto puro**: continua funcionando, mas avisa no boot.
  Migrar com `node scripts/hash-admin-pass.cjs 'SuaSenha'`.

### Qualidade
- Aviso (1x por modelo) quando um modelo sem entrada na tabela de pricing é
  usado (antes o fallback era silencioso).
- Thresholds do hard-dedupe do QueryEngine configuráveis:
  `CLOW_DEDUPE_TURN_KILL` (default 3) e `CLOW_DEDUPE_SESSION_KILL` (default 8).
- Timezone do CRM configurável: `CLOW_CRM_TIMEZONE` (default `America/Sao_Paulo`).
- Testes novos: auth do webhook Asaas, locks por card/tenant, `del()` do
  clusterStore. Testes de prompt desatualizados (5) corrigidos.

## Checklist ANTES do deploy na VPS

1. **Se você usa Asaas**: configure o token, senão os webhooks de pagamento
   param de ser aceitos:
   ```bash
   # gere um token forte
   openssl rand -hex 24
   # adicione no /opt/system-clow/.env
   ASAAS_WEBHOOK_TOKEN=<token>
   ```
   E cole o MESMO token no painel Asaas → Integrações → Webhooks → Token de acesso.
   *Se não usa Asaas, pule.*

2. **(Recomendado) Migrar senha admin pra hash**:
   ```bash
   node scripts/hash-admin-pass.cjs 'SuaSenhaAdmin'
   # cole o CLOW_ADMIN_PASS_HASH='...' gerado no .env e remova CLOW_ADMIN_PASS=
   ```

## Deploy

```bash
ssh root@<vps>
cd /opt/system-clow
git fetch origin claude/friendly-galileo-10cebi
bash scripts/deploy-vps.sh claude/friendly-galileo-10cebi
```

O script salva o commit atual em `.last-deploy-rev`, builda, roda migrations,
faz `pm2 reload` (zero-downtime) e verifica `/health/ready`.

## Verificação pós-deploy

```bash
pm2 logs --lines 50          # sem erros novos no boot
curl -sk https://127.0.0.1:3001/health/ready
# teste real: manda uma msg de WhatsApp pra um card de teste e confirma resposta
```

## Rollback (1 comando)

```bash
cd /opt/system-clow
git checkout "$(cat .last-deploy-rev)" && npm ci && npm run build && pm2 reload all
```
