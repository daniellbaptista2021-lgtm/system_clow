# System Clow - Security & Licensing

## Unauthorized Use Prevention

System Clow is protected against:
- Unauthorized cloning and redistribution
- Resale without license
- CLI access without subscription
- Code tampering (integrity checks)

## Authorized Access Methods

### Web (Subscription Required)
https://system-clow.pvcorretor01.com.br

### Mobile App (PWA)
Install from the web interface

### CLI (License Required)
```bash
export CLOW_LICENSE_TOKEN="your_token"
clow
```

## License Validation

All requests are validated against:
1. License signature (RSA-256)
2. Expiration date
3. Tenant ID
4. Origin tracking

## Tiers

| Tier | Price | Messages/Month | Features |
|------|-------|---------------|----------|
| ONE | R$129.90 | 1,500 | Basic tools |
| SMART | R$297 | 6,000 | +Agent, MCP |
| PROFISSIONAL | R$497 | 25,000 | +Full Bash, Plan |
| BUSINESS | R$897 | 100,000 | +Priority, Custom |

---

For licensing: license@system-clow.com
