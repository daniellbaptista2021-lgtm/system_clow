#!/usr/bin/env bash
# Fecha o EVOX de produção — roda DENTRO do container "evox" da tp2.
# WhatsApp (Evolution), transcrição de áudio, cópia de segurança e a ligação
# de tudo no /etc/evox.env. Idempotente.
set -euo pipefail
cd /root
echo "== WhatsApp (Evolution)"; bash instalar-evolution.sh
echo "== Áudio (whisper)"; bash instalar-whisper.sh
echo "== Cópia de segurança"; install -m 0700 evox-backup.sh /usr/local/bin/evox-backup.sh; echo "script ok"

echo "== Ligando no EVOX"
CHAVE=$(grep '^AUTHENTICATION_API_KEY=' /etc/evolution.env | cut -d= -f2-)
liga() { grep -q "^$1=" /etc/evox.env && sed -i "s|^$1=.*|$1=$2|" /etc/evox.env || echo "$1=$2" >> /etc/evox.env; }
liga EVOLUTION_BASE_URL http://127.0.0.1:8080
liga EVOLUTION_API_KEY "$CHAVE"
liga CLOW_WHISPER_CMD /opt/whisper/whisper-transcribe
systemctl restart evox; sleep 6
echo "evox: $(systemctl is-active evox) · evolution: $(systemctl is-active evolution) · postgres: $(systemctl is-active postgresql)"
curl -s -o /dev/null -w "evolution responde: %{http_code}\n" -H "apikey: $CHAVE" http://127.0.0.1:8080/instance/fetchInstances
rm -f /root/instalar-evolution.sh /root/instalar-whisper.sh /root/evox-backup.sh /root/instalar-no-container.sh
echo "PRONTO NO CONTAINER"
