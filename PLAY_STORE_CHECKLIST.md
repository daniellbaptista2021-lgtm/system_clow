# 🚀 Checklist — Publicar System Clow no Google Play Store

**Tempo estimado total:** ~2 horas de trabalho seu + 1-7 dias de revisão do Google.
**Custo:** US$ 25 (≈ R$ 125-140) — taxa única e vitalícia da Google.

---

## ✅ Já está pronto (feito por mim)

- [x] Política de Privacidade: https://system-clow.pvcorretor01.com.br/privacy.html
- [x] Termos de Uso: https://system-clow.pvcorretor01.com.br/terms.html
- [x] `manifest.json` aprimorado (categories, screenshots, shortcuts, lang pt-BR)
- [x] Ícones maskable 192x192 e 512x512 (com safe area de 60%)
- [x] Screenshots placeholder (4 imagens, 1280x720 + 720x1280)
- [x] `/.well-known/assetlinks.json` (template, com placeholder pro SHA-256)
- [x] Nginx servindo `/.well-known/`, `/privacy.html`, `/terms.html` e screenshots
- [x] Texto da ficha pronto em `PLAY_STORE_LISTING.md`

---

## 📋 PASSO 1 — Criar conta no Google Play Console (10 min)

1. Acesse: **https://play.google.com/console**
2. Faça login com a sua conta Google (ou crie uma — recomendo dedicada pra negócio: `play@pvcorretor01.com.br`)
3. Clique em **"Comece"** → escolha **"Eu mesmo"** (developer individual) ou **"Organização"** (recomendo organização — fica mais profissional)
4. Pague a taxa única de **US$ 25** (cartão internacional)
5. Preencha:
   - Nome do desenvolvedor: `PV Corretor` (ou seu nome)
   - E-mail de contato: `contato@pvcorretor01.com.br`
   - Telefone, endereço, etc
6. Aguarde 24-48h pra verificação de identidade (Google manda e-mail)

---

## 📋 PASSO 2 — Gerar o AAB com PWABuilder (10 min)

1. Acesse: **https://www.pwabuilder.com**
2. No campo "Site URL", cole: `https://system-clow.pvcorretor01.com.br`
3. Clique em **"Start"**
4. Aguarde a análise. Você verá um score (Manifest, Service Worker, Security)
   - Espera-se ✅ verde em tudo (já preparei o manifest e SW está OK)
5. Clique em **"Package For Stores"** → **"Android"**
6. Configure:
   - **Package ID**: `br.com.pvcorretor.systemclow`
   - **App name**: `System Clow`
   - **Launcher name**: `System Clow`
   - **App version**: `1.0.0`
   - **App version code**: `1`
   - **Display mode**: `standalone`
   - **Splash screen color**: `#0F0E14`
   - **Status bar color**: `#1f1d1a`
   - **Navigation bar color**: `#1f1d1a`
   - **Signing key**: deixe **"Create new"** (PWABuilder gera o keystore pra você — **GUARDE ESSE ARQUIVO**, sem ele você não consegue atualizar o app no futuro)
7. Clique em **"Generate"** e aguarde 1-2 min
8. Baixe o `.zip` que ele entrega — tem dentro:
   - `app-release-bundle.aab` ← arquivo pra subir no Play Store
   - `app-release-signed.apk` ← pra testar localmente
   - `signing-key-info.txt` ← contém o **SHA-256** que você vai precisar
   - `assetlinks.json` ← já gerado por eles, com SHA correto

---

## 📋 PASSO 3 — Atualizar o assetlinks.json na VPS (5 min)

> **Crítico**: sem isso, o app abre mostrando barra de URL do Chrome (ruim). Com isso correto, abre 100% fullscreen como app nativo.

1. Abra o `signing-key-info.txt` baixado do PWABuilder
2. Copie o valor do **SHA-256** (formato `XX:XX:XX:...:XX`)
3. SSH na VPS:

```bash
ssh root@<vps-ip>
nano /opt/system-clow/public/.well-known/assetlinks.json
```

4. Substitua a linha:

```json
"PLACEHOLDER_SUBSTITUIR_PELO_SHA256_DO_PWABUILDER"
```

por:

```json
"AB:CD:12:34:...:EF"
```

(o SHA-256 completo que você copiou)

5. Salva, testa:

```bash
curl -s https://system-clow.pvcorretor01.com.br/.well-known/assetlinks.json
```

6. Valide com a ferramenta oficial do Google:
   **https://developers.google.com/digital-asset-links/tools/generator**
   - Hosting site domain: `system-clow.pvcorretor01.com.br`
   - App package name: `br.com.pvcorretor.systemclow`
   - App package fingerprint (SHA256): cole o SHA
   - Clique "Test statement"
   - Resultado esperado: `Success! The statement is valid.`

---

## 📋 PASSO 4 — Subir o app no Play Console (30 min)

Depois que o Google aprovar sua conta de developer (passo 1):

### 4.1 — Criar o app

1. Play Console → **"Criar app"**
2. Preencha:
   - **Nome do app**: `System Clow`
   - **Idioma padrão**: Português (Brasil)
   - **App ou jogo**: App
   - **Pago ou gratuito**: **Gratuito**
   - Marque as 2 declarações obrigatórias
3. **Criar app**

### 4.2 — Configurar versão de produção

1. Menu lateral → **"Produção"** → **"Criar nova versão"**
2. **App bundles**: clique **"Upload"** e suba o `.aab` baixado do PWABuilder
3. **Nome da versão**: `1.0.0`
4. **Notas da versão**: cole o conteúdo de **"What's New"** do `PLAY_STORE_LISTING.md`
5. **Salvar** (não envie pra revisão ainda)

### 4.3 — Preencher ficha da loja

Menu lateral → **"Configurar app"** → vai listar todos os requisitos. Aqui usa o `PLAY_STORE_LISTING.md`:

- [ ] **Acesso ao app**: marque "Todas as funcionalidades estão disponíveis sem restrições" (você já tem login na home — eles testam visitando a URL)
- [ ] **Anúncios**: "Não, meu app não contém anúncios"
- [ ] **Classificação de conteúdo**: complete o questionário (use a tabela em `PLAY_STORE_LISTING.md` → Content Rating)
- [ ] **Público-alvo**: 18+ (Business)
- [ ] **Notícias**: Não
- [ ] **App de COVID-19**: Não
- [ ] **Privacidade dos dados**: cole as declarações da seção "Privacy & data safety" do `PLAY_STORE_LISTING.md`
- [ ] **Política de Privacidade**: `https://system-clow.pvcorretor01.com.br/privacy.html`
- [ ] **Categoria do app**: Negócios
- [ ] **Tags**: business, productivity, communication

### 4.4 — Ficha principal da loja

Menu lateral → **"Crescer usuários"** → **"Ficha principal da loja"**:

- **Nome do app**: `System Clow`
- **Descrição curta** (80 chars): cole de `PLAY_STORE_LISTING.md`
- **Descrição completa** (4000 chars): cole de `PLAY_STORE_LISTING.md`
- **Ícone do app** (512x512): faça upload de `assets/icon-512-gold.png`
- **Imagem do recurso** (1024x500): você precisa criar. Sugestões:
  - Canva → "Google Play Feature Graphic" → use as cores `#9B59FC` e `#4A9EFF`
  - Texto: "CRM + WhatsApp + IA" e "system-clow.pvcorretor01.com.br"
- **Capturas de tela do telefone** (mínimo 2, máximo 8):
  - Faça upload de `assets/screenshots/screenshot-pipeline.png`
  - `assets/screenshots/screenshot-conversa.png`
  - `assets/screenshots/screenshot-contatos.png`
  - `assets/screenshots/screenshot-mobile.png`
  - **RECOMENDADO**: tirar prints REAIS do app (você tem a UI rodando) e substituir os placeholders. Mais convincente.
- **Capturas de tablet 7"** (opcional)
- **Capturas de tablet 10"** (opcional)

### 4.5 — Enviar pra revisão

1. Volte em **"Produção"**
2. Clique **"Revisar versão"**
3. Cheque os warnings
4. Clique **"Iniciar lançamento de produção"**
5. Aguarde 1-7 dias úteis (revisão Google)
6. Você recebe e-mail com aprovação ou rejeição (com motivo)

---

## 📋 PASSO 5 — Pós-aprovação

Quando aprovado:
- O app aparece na Play Store em **~3 horas**
- URL fica tipo: `https://play.google.com/store/apps/details?id=br.com.pvcorretor.systemclow`
- Adicione esse link no rodapé do site, signature de e-mail, materiais de venda

### Atualizações futuras

**A grande sacada do PWA via TWA**: como o app é só um shell em volta do seu site, **toda atualização do site = atualização instantânea do app**, sem precisar republicar nada na Play Store.

Você só precisa republicar o AAB se quiser:
- Mudar ícone do app
- Mudar nome
- Mudar permissões
- Atualizar versão (versionCode + 1, versionName novo)

---

## ⚠️ Possíveis problemas e soluções

| Problema | Solução |
|---|---|
| Google rejeita por "broken functionality" | Eles testam o site. Garantir que `https://system-clow.pvcorretor01.com.br` está 100% no ar quando o app for revisado |
| Rejeição por "missing privacy policy" | A URL `/privacy.html` precisa estar acessível e visível na ficha do Play Store |
| Rejeição "deceptive content" | NÃO mencionar funcionalidades que o app não tem (ex: não dizer "WhatsApp" como se fosse oficial — diga "integração com WhatsApp Business API") |
| App abre com barra do Chrome (não fullscreen) | `assetlinks.json` com SHA errado. Refaça o passo 3 |
| Validation error no manifest | Rode validador: https://manifest-validator.appspot.com/ → cole `https://system-clow.pvcorretor01.com.br/manifest.json` |
| "Suspicious app behavior" | Geralmente porque o app pede MUITAS permissões. TWAs herdam só permissões básicas (internet) — não deve dar problema |

---

## 📞 Suporte

Se algo travar no processo, me avisa que ajudo a destravar. Os assets estão todos prontos:

```
✅ /privacy.html  → online
✅ /terms.html    → online
✅ /manifest.json → online (com 4 screenshots, shortcuts, maskable)
✅ /.well-known/assetlinks.json → online (precisa só substituir SHA depois)
✅ /assets/icon-512-maskable.png → online
✅ /assets/icon-192-maskable.png → online
✅ /assets/screenshots/*.png → online (4 placeholders)
```

Boa sorte! 🚀
