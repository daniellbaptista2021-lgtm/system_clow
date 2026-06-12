# Backlog de Descobertas — 2026-05-06

Coisas que apareceram durante o hardening e ficaram FORA do escopo dos 2 itens (fix tools quebradas + output validator). Não corrigidos por falta de pedido explícito ou pra evitar cascata.

## Descobertas técnicas

### 1. `promover_para_lancar_venda` retorna ok=false 14x/24h por design
Não é bug. Guard duro adicionado por Daniel em 2026-05-06 bloqueia promoção sem cpf/cep/cotação coletados. LLM fica chamando sem ter coletado os dados → erro. Próximo passo: limitar tentativas da MESMA tool por turno (3 tentativas → escalar humano automaticamente). Hoje só vai até `MAX_TOOL_ITERATIONS=4` que aplica a TODAS as tools.

### 2. `ler_dados_card` com `unmask=true` retorna ok=false 59x/24h
Comportamento esperado: tool só permite unmask pra role `coletor`. LLM como vendedor tenta usar unmask, falha. Não é bug, mas é desperdício de turno LLM. Solução: descrição da tool deveria deixar mais claro "unmask SÓ funciona pra coletor — você é vendedor, não use".

### 3. `safira-pr52.test.ts` tem 7 testes falhando (pré-existente)
Testa `PROMPT_VENDEDOR_FUNERAL` esperando string `PRODUTO ADICIONAL`. Prompt atual não tem essa string. Pode ser regressão silenciosa OU teste desatualizado. Não investigado.

### 4. Cards em status `escalated` ficam parados sem ninguém atender
18 cards `escalated` há mais de 24h em PV. Bot fez handoff mas humano não viu. Falta dashboard / alerta automático (item 6 do plano original — descartado pelo Daniel: não quer Telegram).

### 5. `findUnrespondedInboundCards` (safety net) está DESABILITADO no scheduler
Comentário em `columnTimerScheduler.ts:436-444` explica: "DISABLED 2026-05-05 — safety net disparou bot em cards velhos onde LLM gerou meta-commentary que passou pelo filtro looksLikeMetaCommentary, vazando relato interno pro cliente (3 vendas perdidas reportado pelo Daniel)". Reabilitar SÓ depois de output validator funcionar 7 dias sem regressão.

### 6. Race entre debounce de inbound e scheduler chase é mitigada mas não resolvida
`rapid_fire_cooldown` (60s) bloqueia se bot acabou de mandar msg. Mas se inbound chega exatamente no mesmo instante que scheduler dispara, a janela <1s pode dar dispatch duplo. Não vi acontecer nesta janela. Lock único por card resolveria definitivamente — não foi feito (Daniel pediu pra não mexer no que tá rodando).

### 7. Conversas antigas com erros visíveis ainda no histórico do cliente
Cards de Sandra Maria, Adriana, Luiz, Norma, Samuel têm mensagens vazadas e contraditórias no WhatsApp do cliente. Bot futuro lê últimas 20 msgs — geralmente tira do contexto, mas em conversas curtas pode reforçar erro. Não foi limpo (não foi pedido).

### 8. API SulAmérica timeout 4x/24h
Aumentado timeout de 60s pra 90s + log de latência. Se >30% das chamadas continuarem timeout, considerar fallback explícito ("não consegui cotar agora, tento de novo em alguns minutos"). Métrica recém-instalada — observar 7 dias antes de decidir.

### 9. `tool_loop_max` 29x/24h
LLM atingiu 4 iterações de tool calls sem produzir resposta final. Pode indicar:
- LLM em loop chamando mesma tool que falha (caso `promover_para_lancar_venda` sem dados)
- Tools com erro persistente
- Prompt confuso em certos cenários

Não investigado caso a caso. Métrica importante de observar.

### 10. Prompt PV vendedor atualmente em 41.925 chars
Daniel adicionou regras incrementalmente em todas as sessões recentes. Tamanho cresceu. LLMs com prompts >30k tendem a perder fidelidade em algumas regras. Item 7 do plano original (modularização) ficou de fora — risco alto sem A/B test estruturado.

## Descobertas de produto/regra

### 11. Coberturas opcionais reais do plano (vistas via API):
- Despesas Médicas/Hospitalares/Odontológicas por acidente (R$500–R$10k)
- Acessibilidade Física por acidente (R$10k–R$300k)
- Diária Hospitalar por acidente (R$100–R$1500/dia)
- Médico na Tela Familiar (telemedicina)
- Rede de Saúde Familiar

Bot conhece todas via prompt mas não cota todas — só cota quando cliente pede. OK.

### 12. Benefícios fixos (sem custo extra) que o bot pouco menciona:
- Clube de Vantagens
- Sorteios Mensais
- Descontos em Farmácia/Medicamentos

Adicionados ao prompt em 2026-05-06. Bot deveria mencionar pra qualificar a venda.

## Descobertas de processo

### 13. Migração de prompt PV não tem rollback automático
Quando Daniel pediu correção do cônjuge, eu UPDATE direto na coluna `crm_columns.agent_system_prompt`. Backup foi feito em `/root/.clow/backups/`. Mas não tem restore automático — se uma mudança quebrar o bot, é Python script manual.

### 14. Prompts default em `defaultPrompts.ts` divergem do DB
Tenants ativos (PV) têm prompt customizado em DB. Mudança em `defaultPrompts.ts` NÃO afeta PV. Mirror precisa ser feito explicitamente em ambos. Memória registrada em `feedback_pv_prompts_custom_in_db.md`.
