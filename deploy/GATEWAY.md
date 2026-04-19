# System Clow — Gateway OpenRouter via LiteLLM

System Clow usa `@anthropic-ai/sdk` por padrao, mas via `ANTHROPIC_BASE_URL`
pode ser redirecionado pra um proxy LiteLLM local que traduz pra qualquer
provider compativel (OpenRouter, Groq, Together, etc).

Atualmente em producao (VPS <vps-ip>):
- LiteLLM em `http://127.0.0.1:4000`
- Modelo: `z-ai/glm-5.1` via OpenRouter
- System Clow: `CLOW_MODEL=glm-5.1`, `ANTHROPIC_BASE_URL=http://127.0.0.1:4000`

## Setup

1. Instalar LiteLLM:
   ```
   pip install litellm[proxy]
   ```

2. Copiar `litellm-config.example.yaml` pra `/opt/litellm/config.yaml`.

3. Copiar `litellm-start.example.sh` pra `/opt/litellm/start.sh`, setar
   `OPENROUTER_API_KEY` real e `chmod +x`.

4. Subir via PM2:
   ```
   pm2 start /opt/litellm/start.sh --name litellm
   pm2 save
   ```

5. No `.env` do System Clow:
   ```
   ANTHROPIC_API_KEY=sk-clow-proxy-local
   ANTHROPIC_BASE_URL=http://127.0.0.1:4000
   CLOW_MODEL=glm-5.1
   ```

6. Build e restart:
   ```
   cd /opt/system-clow && npm run build
   pm2 restart clow --update-env
   ```

## Validacao

```
curl -s http://127.0.0.1:4000/v1/messages   -H 'Content-Type: application/json'   -H 'anthropic-version: 2023-06-01'   -d '{"model":"glm-5.1","max_tokens":50,"messages":[{"role":"user","content":"PONG"}]}'
```

Retorno esperado: `{"id":"gen-...","type":"message","model":"glm-5.1",...}`

## Trocar de modelo

Edita `/opt/litellm/config.yaml` mudando `model: openrouter/z-ai/glm-5.1`
pra qualquer um da OpenRouter (`openrouter/openai/gpt-4`, `openrouter/anthropic/claude-sonnet-4.5`, etc) e `pm2 restart litellm`. O System Clow nao precisa de rebuild.
