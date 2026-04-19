#!/bin/bash
# Wrapper pra PM2. Colocar OPENROUTER_API_KEY aqui (fora do repo).
export OPENROUTER_API_KEY='sk-or-v1-REDACTED'
unset LITELLM_MASTER_KEY
unset DATABASE_URL
exec /usr/local/bin/litellm --config /opt/litellm/config.yaml --port 4000 --host 127.0.0.1
