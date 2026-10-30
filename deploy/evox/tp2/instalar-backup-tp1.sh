#!/usr/bin/env bash
# Cópia diária do EVOX na tp1 (busca da tp2 com a chave do parque). Roda NA tp1.
set -euo pipefail
install -m 0700 /root/evox-backup-puxar.sh /usr/local/bin/evox-backup-puxar.sh
cat > /etc/systemd/system/evox-backup.service <<'UNIT'
[Unit]
Description=Copia de seguranca do EVOX (tp2 -> tp1)
[Service]
Type=oneshot
ExecStart=/usr/local/bin/evox-backup-puxar.sh
UNIT
cat > /etc/systemd/system/evox-backup.timer <<'UNIT'
[Unit]
Description=Copia diaria do EVOX (04:30)
[Timer]
OnCalendar=*-*-* 04:30:00
Persistent=true
RandomizedDelaySec=10m
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now evox-backup.timer >/dev/null 2>&1
/usr/local/bin/evox-backup-puxar.sh
rm -f /root/evox-backup-puxar.sh /root/instalar-backup-tp1.sh
echo "PRONTO NA tp1 — proxima copia: $(systemctl show evox-backup.timer -p NextElapseUSecRealtime --value)"
