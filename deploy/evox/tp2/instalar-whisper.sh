#!/usr/bin/env bash
# Transcrição de áudio do Agente IA no servidor (o mesmo faster-whisper do Mac).
# Roda DENTRO do container "evox". Modelo "small" em int8: ~500 MB de memória.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
dpkg -s python3-venv >/dev/null 2>&1 || apt-get install -y -qq python3-venv >/dev/null
[ -x /opt/whisper/venv/bin/python ] || python3 -m venv /opt/whisper/venv
/opt/whisper/venv/bin/pip install -q --upgrade pip >/dev/null
/opt/whisper/venv/bin/pip install -q faster-whisper >/dev/null
cat > /opt/whisper/whisper-transcribe <<'SH'
#!/bin/bash
# Uso: whisper-transcribe <arquivo de áudio>  -> texto no stdout.
exec /opt/whisper/venv/bin/python - "$1" <<'PY'
import sys, time, os
from faster_whisper import WhisperModel
t = time.time()
m = WhisperModel(os.environ.get("WHISPER_MODEL", "small"), device="cpu", compute_type="int8", download_root="/opt/whisper/modelos")
segs, info = m.transcribe(sys.argv[1], language=os.environ.get("WHISPER_LANGUAGE", "pt"), vad_filter=True)
print(" ".join(s.text.strip() for s in segs).strip())
print(f"idioma={info.language} tempo={time.time()-t:.1f}s", file=sys.stderr)
PY
SH
chmod 755 /opt/whisper/whisper-transcribe
# Baixa o modelo agora (a primeira mensagem de voz não espera o download).
/opt/whisper/venv/bin/python -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8', download_root='/opt/whisper/modelos')" 2>/dev/null
echo "whisper ok"
