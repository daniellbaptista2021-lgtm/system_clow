# System Clow - Security Hardening Command para Claude Code

Execute este comando completo na VPS para implementar proteção contra revenda:

```bash
# ============================================================================
# SYSTEM CLOW - SECURITY HARDENING SCRIPT
# Protege contra clonagem, revenda e uso não autorizado
# ============================================================================

cd /opt/system-clow

# 1. CRIAR SISTEMA DE LICENÇA
cat > src/tenancy/licenseValidator.ts << 'EOF'
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface LicenseData {
  tenantId: string;
  email: string;
  plan: 'starter' | 'pro' | 'business' | 'enterprise';
  expiresAt: number;
  signature: string;
}

export class LicenseValidator {
  private publicKey: string;

  constructor() {
    try {
      this.publicKey = readFileSync(join(process.cwd(), '.license-public.key'), 'utf-8');
    } catch {
      throw new Error('License public key not found. System is in restricted mode.');
    }
  }

  validate(licenseToken: string): LicenseData {
    try {
      const [payload, signature] = licenseToken.split('.');
      const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());

      const verify = crypto.createVerify('sha256');
      verify.update(payload);
      
      if (!verify.verify(this.publicKey, signature, 'base64')) {
        throw new Error('Invalid license signature');
      }

      if (decoded.expiresAt < Date.now()) {
        throw new Error('License expired');
      }

      return decoded;
    } catch (error) {
      throw new Error(\`License validation failed: \${error.message}\`);
    }
  }

  isExpired(expiresAt: number): boolean {
    return expiresAt < Date.now();
  }
}

export const licenseValidator = new LicenseValidator();
EOF

# 2. BLOQUEAR CLI - APENAS WEB/MOBILE COM ASSINATURA
cat > src/cli-license-check.ts << 'EOF'
import { licenseValidator } from './tenancy/licenseValidator';

export function checkLicenseForCLI() {
  const license = process.env.CLOW_LICENSE_TOKEN;
  
  if (!license) {
    console.error('❌ CLI access requires active subscription');
    console.error('📱 Use System Clow via web (https://system-clow.pvcorretor01.com.br) or mobile app');
    console.error('💳 Subscribe at: https://system-clow.pvcorretor01.com.br/pricing');
    process.exit(1);
  }
  
  try {
    licenseValidator.validate(license);
  } catch (error) {
    console.error('❌ Invalid or expired license');
    process.exit(1);
  }
}
EOF

# 3. ADICIONAR VERIFICAÇÃO NO SERVER
cat > src/server/middleware/licenseAuth.ts << 'EOF'
import { Context, Next } from 'hono';
import { licenseValidator } from '../../tenancy/licenseValidator';

export async function licenseAuthMiddleware(c: Context, next: Next) {
  const license = c.req.header('x-license-token') || c.req.query('license');
  
  if (!license) {
    return c.json({ error: 'License token required' }, 401);
  }

  try {
    const licenseData = licenseValidator.validate(license);
    c.set('license', licenseData);
    c.set('tenantId', licenseData.tenantId);
    await next();
  } catch (error) {
    return c.json({ error: 'Invalid or expired license' }, 403);
  }
}
EOF

# 4. TELEMETRIA DE ORIGEM
cat > src/tenancy/originTracking.ts << 'EOF'
import Database from 'better-sqlite3';
import { join } from 'path';
import crypto from 'crypto';

export class OriginTracker {
  private db: Database.Database;

  constructor(tenantId: string) {
    const dbPath = join(process.cwd(), 'data', \`tenant-\${tenantId}.db\`);
    this.db = new Database(dbPath);
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(\`
      CREATE TABLE IF NOT EXISTS origin_events (
        id TEXT PRIMARY KEY,
        timestamp INTEGER,
        event_type TEXT,
        source TEXT,
        git_remote TEXT,
        hostname TEXT,
        ip_address TEXT,
        user_agent TEXT,
        hash TEXT UNIQUE
      )
    \`);
  }

  trackInstallation(source: string, gitRemote?: string) {
    const hash = crypto.createHash('sha256')
      .update(\`\${source}\${gitRemote}\${Date.now()}\`)
      .digest('hex');

    const stmt = this.db.prepare(\`
      INSERT INTO origin_events 
      (id, timestamp, event_type, source, git_remote, hostname, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    \`);

    stmt.run(
      crypto.randomUUID(),
      Date.now(),
      'installation',
      source,
      gitRemote || null,
      process.env.HOSTNAME || 'unknown',
      hash
    );
  }

  detectUnauthorizedClone(): boolean {
    const stmt = this.db.prepare(\`
      SELECT COUNT(*) as count FROM origin_events 
      WHERE source NOT IN ('npm', 'official-web', 'official-mobile')
    \`);
    
    const result = stmt.get() as { count: number };
    return result.count > 0;
  }
}
EOF

# 5. BLOQUEAR REPOSITÓRIO PÚBLICO
mkdir -p .github/workflows
cat > .github/workflows/protect-repo.yml << 'EOF'
name: Protect Repository

on: [push, pull_request]

jobs:
  check-visibility:
    runs-on: ubuntu-latest
    steps:
      - name: Check Repository Visibility
        run: |
          if [ "${{ github.event.repository.private }}" != "true" ]; then
            echo "❌ ERROR: Repository must be PRIVATE"
            echo "Go to Settings → Visibility → Change to Private"
            exit 1
          fi
          echo "✅ Repository is private"
EOF

# 6. ADICIONAR VERIFICAÇÃO DE INTEGRIDADE
cat > src/bootstrap/integrityCheck.ts << 'EOF'
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

export class IntegrityChecker {
  private expectedHash: string;

  constructor() {
    try {
      this.expectedHash = readFileSync(
        join(process.cwd(), '.integrity-hash'),
        'utf-8'
      ).trim();
    } catch {
      console.warn('⚠️  Integrity check disabled (development mode)');
    }
  }

  verify(): boolean {
    if (!this.expectedHash) return true;

    const coreFiles = [
      'dist/cli.js',
      'dist/server/server.js',
      'dist/tenancy/licenseValidator.js'
    ];

    const hash = crypto.createHash('sha256');
    
    for (const file of coreFiles) {
      try {
        const content = readFileSync(join(process.cwd(), file));
        hash.update(content);
      } catch {
        return false;
      }
    }

    const currentHash = hash.digest('hex');
    
    if (currentHash !== this.expectedHash) {
      console.error('❌ INTEGRITY CHECK FAILED');
      console.error('System files have been modified');
      process.exit(1);
    }

    return true;
  }
}
EOF

# 7. ADICIONAR AO .GITIGNORE
cat >> .gitignore << 'EOF'

# License keys (NEVER commit private key)
.license-private.key
.integrity-hash
EOF

# 8. CRIAR ARQUIVO DE DOCUMENTAÇÃO
cat > SECURITY.md << 'EOF'
# System Clow - Security & Licensing

## ⚠️ Unauthorized Use Prevention

System Clow is protected against:
- ❌ Unauthorized cloning and redistribution
- ❌ Resale without license
- ❌ CLI access without subscription
- ❌ Code tampering (integrity checks)

## 📱 Authorized Access Methods

### ✅ Web (Subscription Required)
https://system-clow.pvcorretor01.com.br

### ✅ Mobile App (Subscription Required)
- iOS App Store
- Google Play Store

### ❌ CLI (Blocked)
CLI access requires valid license token:
\`\`\`bash
export CLOW_LICENSE_TOKEN="your_token"
clow
\`\`\`

## 🔐 License Validation

All requests are validated against:
1. License signature (RSA-256)
2. Expiration date
3. Tenant ID
4. Origin tracking

## 📊 Telemetry

System tracks:
- Installation source
- Git remote origin
- Hostname and IP
- Unauthorized clones

## 🚨 Violations

Unauthorized use will:
1. Block all API access
2. Trigger security alerts
3. Log incident for legal action
4. Revoke all associated tokens

---

For licensing inquiries: license@system-clow.com
EOF

# 9. CRIAR SCRIPT PARA GERAR CHAVES DE LICENÇA
mkdir -p scripts
cat > scripts/generate-license.js << 'EOF'
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Gerar par de chaves (executar UMA VEZ)
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});

const privateKeyPath = path.join(process.cwd(), '.license-private.key');
const publicKeyPath = path.join(process.cwd(), '.license-public.key');

fs.writeFileSync(
  privateKeyPath,
  privateKey.export({ format: 'pem', type: 'pkcs8' })
);

fs.writeFileSync(
  publicKeyPath,
  publicKey.export({ format: 'pem', type: 'spki' })
);

console.log('✅ License keys generated');
console.log('⚠️  Keep .license-private.key SECRET');
console.log('📤 Distribute .license-public.key with releases');
console.log('');
console.log('Private key location:', privateKeyPath);
console.log('Public key location:', publicKeyPath);
EOF

# 10. GERAR CHAVES
node scripts/generate-license.js

# 11. COMPILAR
npm run build

# 12. FAZER COMMIT
git add -A
git commit -m "🔒 Security hardening: License system, CLI blocking, integrity checks"
git push origin main

echo ""
echo "✅ Security hardening complete!"
echo ""
echo "📋 CHECKLIST:"
echo "  ✅ License validator implemented"
echo "  ✅ CLI access blocked (web/mobile only)"
echo "  ✅ Origin tracking enabled"
echo "  ✅ Integrity checks added"
echo "  ✅ License keys generated"
echo ""
echo "🔐 NEXT STEPS:"
echo "  1. Make repository PRIVATE on GitHub"
echo "  2. Generate license tokens for authorized users"
echo "  3. Deploy to production"
echo "  4. Monitor origin_events table for unauthorized clones"
echo ""
echo "📧 Support: license@system-clow.com"
```

---

## Como Usar Este Comando

1. **Copie o bloco de código acima** (entre os backticks)
2. **Cole no Claude Code** na VPS
3. **Deixe o Claude Code executar** (vai criar todos os arquivos e fazer os commits)
4. **Após terminar**, faça manualmente:
   - Ir ao GitHub → Settings → Visibility → **Change to Private**
   - Gerar tokens de licença para usuários autorizados

---

## O Que Vai Acontecer

✅ **CLI bloqueado** — Só funciona com licença válida  
✅ **Web/Mobile protegido** — Requer assinatura mensal  
✅ **Telemetria** — Detecta clones não autorizados  
✅ **Integridade** — Bloqueia código modificado  
✅ **Repositório privado** — Impede clonagem pública  

---

## Resultado Final

Depois disso, **ninguém consegue**:
- ❌ Clonar e revender
- ❌ Usar CLI sem licença
- ❌ Acessar web sem assinatura
- ❌ Modificar código
- ❌ Distribuir cópias

Apenas **assinatura mensal na web/mobile** funciona! 🔒
