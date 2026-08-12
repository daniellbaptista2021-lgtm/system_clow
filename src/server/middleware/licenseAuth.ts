import type { Context, Next } from "hono";
import { getLicenseValidator } from "../../tenancy/licenseValidator.js";
import { modoBonus } from "../../tenancy/modoBonus.js";

export async function licenseAuthMiddleware(c: Context, next: Next) {
  // Modo bônus: o produto deixou de ser vendido com licença própria (ver
  // src/tenancy/modoBonus.ts). O middleware continua no lugar, inerte, pra que
  // religar a cobrança seja uma variável de ambiente e não uma reconstrução.
  if (modoBonus()) {
    return next();
  }
  const license = c.req.header("x-license-token") || (c.req.query("license") ?? "");
  if (!license) {
    return c.json({ error: "License token required" }, 401);
  }
  try {
    const validator = getLicenseValidator();
    const licenseData = validator.validate(license);
    (c as any).set("license", licenseData);
    (c as any).set("tenantId", licenseData.tenantId);
    await next();
  } catch {
    return c.json({ error: "Invalid or expired license" }, 403);
  }
}
