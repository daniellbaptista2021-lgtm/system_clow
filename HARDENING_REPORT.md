# Hardening Report — 2026-05-06

Branch: `fix/hardening-2026-05`
Sessões executadas: **1 (fix tools quebradas)** + **3 (output validator)**
Sessão 2 (dashboard Telegram) descartada por decisão do Daniel.

## Sumário executivo

Atacadas 2 frentes estruturais ao invés de patches reativos:

1. **Tools quebradas** — `agendar_followup` aceitava só ISO 8601 (LLM passava
   "+24h", "DD/MM/YYYY", "YYYY-MM-DD" e falhava 14x/24h). `cotar_sulamerica_api`
   timeout em 60s sem log de latência (4 timeouts/24h). `promover_para_lancar_venda`
   confirmado como guard intencional (não é bug, é proteção contra venda sem dados).
2. **Validador programático anti-currency** — defesa em camadas além do regex.
   Se bot cita valor monetário (R$ XX,XX) sem ter chamado `cotar_sulamerica_api`
   neste turno, bloqueia + força regenerar. Cobre o vetor "valor inventado"
   (caso real Adriana 2026-04-29: "Familiar Ampliado por R$ 133,90" fabricado).

## Itens entregues

### [HARDENING 1/2] Tools quebradas (commit `[hash]`)

**Mudanças:**
- `src/crm/agents/tools/common.ts`:
  - `parseFollowupDate()` exportada — parser permissivo aceita ISO 8601, ISO
    date-only ("2026-05-08" → 14h BRT), formato BR ("DD/MM/YYYY HH:MM"),
    relativo ("+24h", "+2d"). Ordem dos checks importa (regex BR antes de
    Date.parse senão interpreta como US format).
  - Tolerância de 60s no passado (cobre latência LLM); senão ajusta pra +1h.
  - Log warn quando data inválida (antes era silencioso).
- `src/crm/agents/tools/cotacao_sulamerica.ts`:
  - Timeout 60s → 90s.
  - Log info de latência em todo request (sucesso E falha) com formato
    `[cotar_sulamerica_api] OK latency=Xms produtos=N` ou
    `[cotar_sulamerica_api] TIMEOUT latency=Xms`.
- `tests/crm/unit/tools-common.test.ts`: 13 testes cobrindo parser.

**Aceite:**
- 13/13 testes verde.
- typecheck limpo.
- Build OK.
- Reload pm2 OK.

### [HARDENING 2/2] Output validator anti-currency (commit `[hash]`)

**Mudanças:**
- `src/crm/agents/outputValidator.ts` (novo, 75 linhas):
  - Detecta valor monetário em texto (regex `R\$\s*[\d.,]+(\s*(mil|milhão|milhões))?`).
  - Track de tools chamadas no turno (`{ name, ok }[]`).
  - Whitelist de tools de cotação: `cotar_sulamerica_api`, `gerar_cotacao_sulamerica`.
  - Se cita valor + cotou ok → passa; senão → bloqueia com feedback actionable.
- `src/crm/agents/columnAgentRunner.ts`:
  - Track `toolCallsThisTurn` em `runColumnAgent` (lista populada após cada
    `executeToolCall`).
  - Validação chamada antes de `break` final do tool loop.
  - Se bloqueia, injeta mensagem de feedback pro LLM regenerar UMA vez.
  - Se bloqueia 2x, aborta envio (metric `output_validator_unbacked_currency_persistent`).
  - Mesma lógica em `runFromInactivityFire` com sufixo `_inactivity`.
- `tests/crm/unit/outputValidator.test.ts`: 18 testes (9 bloqueia, 6 autoriza,
  3 casos de borda).

**Aceite:**
- 31 testes pass (13 parser + 18 validator).
- 286/286 testes na suite completa pass.
- typecheck limpo.
- Build OK.
- Reload pm2 OK.
- E2E real: cliente "Daniel" no card PV pediu cotação com indenização R$100k,
  bot chamou `cotar_sulamerica_api` (latency=1850ms), cotou R$ 39,90/mês,
  validador autorizou envio, mensagem chegou no WhatsApp do Daniel com
  cotação correta (Casal e Filhos / capital R$100.000 / R$39,90/mês).

## Métricas — antes vs depois

**Janela das 24h ainda contém quase só dados PRÉ-deploy** (deploy foi 15min
antes do baseline pos). Os números abaixo refletem o pre-state. Métricas
reais do hardening vão aparecer nas próximas 24h conforme tráfego flui pelo
código novo.

| Métrica | Pre-hardening | Pos-deploy (15min) | Esperado em 24h |
|---|---|---|---|
| meta_leaks vazados | 6 | 6 | <2 |
| empty/lixo vazados | 20 | 20 | <2 |
| `agendar_followup` falhas | 14 | 14 | <2 |
| `cotar_sulamerica_api` timeouts | 4 | 4 | <2 |
| `promover_para_lancar_venda` falhas | 14 | 14 | mantém (é guard) |
| tool_loop_max | 29 | 29 | <10 |
| Cards travados (escalated/paused/done) | 45 | 45 | precisa fluxo manual |
| Bloqueios `output_validator_*` (NOVO) | n/a | 0 | observar |

## Validação E2E real

Realizado em ambiente de produção, simulando inbound do número do Daniel:

1. **Cenário 1 — confirmação de idade ambígua:**
   - Inbound: "Quanto fica o plano pra mim 50 anos e minha esposa 48?"
   - Bot: "Hmm, Daniel, você falou 62 anos antes e agora 50 — qual é sua
     idade certinha mesmo?" (verifica histórico, evita inventar valor sem
     dado certo).
2. **Cenário 2 — cotação com indenização:**
   - Inbound: "Pode considerar 50 anos. Manda valor pro plano familiar com
     indenização R$ 100 mil"
   - Bot chamou `salvar_dados_qualificacao` ✅
   - Bot chamou `cotar_sulamerica_api` (capMA=100000, funeral=casal_filhos) ✅
   - Bot enviou cotação com valor real R$ 39,90/mês — validator autorizou
     porque tool de cotação foi chamada com sucesso.

## Riscos remanescentes

1. **Validador anti-currency só cobre "R$ XXX"** — se bot inventar cobertura
   sem citar valor (ex: "tem cobertura X"), passa. Whitelist de coberturas
   ficou de fora desta entrega.
2. **9 itens em BACKLOG_DESCOBERTAS.md** — `safira-pr52` failures, lock
   único por card, race <1s entre debounce e scheduler, dashboard de cards
   travados, etc.
3. **Métricas reais ainda não observadas** — janela de 24h precisa rodar.
   Próxima sessão deve incluir baseline pos REAL (com dados pos-deploy).
4. **45 cards em estado intermediário** — sem dashboard, Daniel precisa
   olhar manualmente.

## Como verificar em prod

```bash
# Latência da API SulAmérica nas próximas chamadas
pm2 logs clow | grep "\[cotar_sulamerica_api\]"

# Bloqueios do validator anti-currency
sqlite3 /root/.clow/crm.sqlite3 "SELECT count(*), reason FROM crm_agent_metrics WHERE reason LIKE 'output_validator%' GROUP BY reason"

# Falhas de agendar_followup pós-fix (esperado: ZERO com novos formatos)
sqlite3 /root/.clow/crm.sqlite3 "SELECT count(*) FROM crm_agent_metrics WHERE reason LIKE '%agendar_followup%' AND event='tool_failed' AND occurred_at > strftime('%s','now','-1 hour')*1000"
```

## Arquivos modificados

```
src/crm/agents/columnAgentRunner.ts         (+50 linhas — track toolCalls + validator hook)
src/crm/agents/outputValidator.ts            (NOVO, +75 linhas)
src/crm/agents/tools/common.ts               (+58 linhas — parseFollowupDate)
src/crm/agents/tools/cotacao_sulamerica.ts  (+8 linhas — timeout/log)
tests/crm/unit/tools-common.test.ts         (NOVO, +88 linhas)
tests/crm/unit/outputValidator.test.ts       (NOVO, +145 linhas)
BACKLOG_DESCOBERTAS.md                       (NOVO)
HARDENING_REPORT.md                          (este arquivo)
baseline_pre_hardening.txt                   (em /root/.clow/)
baseline_pos_hardening.txt                   (em /root/.clow/)
```
