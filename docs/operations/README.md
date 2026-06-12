# Operações — System Clow

Documentação operacional pro launch dos 500 corretores e suporte 24/7 depois.

| Documento | Quando ler |
|---|---|
| [soft-launch-checklist.md](soft-launch-checklist.md) | 24h antes de abrir cadastro pros 500 corretores |
| [incident-runbook.md](incident-runbook.md) | Quando algo quebrou e você quer um playbook por sintoma |
| [on-call-handbook.md](on-call-handbook.md) | Acordou com alerta no Telegram e não sabe por onde começar |
| [rollback.md](rollback.md) | Deploy ruim — preciso reverter em < 5 min |

Todos escritos no formato "3 da manhã, sistema fora do ar, tô com sono": comandos prontos pra colar, decisões em 30 segundos, sem explicação genérica.

## Convenção de variáveis

Todos os docs assumem que você exportou:

```bash
export VPS_IP=<vps-ip>                    # IP da VPS (não está versionado por gitleaks)
export DOMAIN=system-clow.pvcorretor01.com.br
export METRICS_TOKEN=<valor-do-.env>      # token do /metrics
```

Se não tem o `METRICS_TOKEN`, pega no `.env`:

```bash
ssh root@$VPS_IP 'grep METRICS_TOKEN /opt/system-clow/.env'
```
