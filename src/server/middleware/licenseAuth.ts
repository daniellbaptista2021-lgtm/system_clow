import type { Context, Next } from "hono";
import { getLicenseValidator } from "../../tenancy/licenseValidator.js";
import { logger } from "../../utils/logger.js";

let _queryParamWarned = false;

export async function licenseAuthMiddleware(c: Context, next: Next) {
  const headerLicense = c.req.header("x-license-token");
  const queryLicense = c.req.query("license") ?? "";
  // Query string vaza em logs de proxy/CDN/access-log — aceita por
  // retrocompatibilidade, mas avisa pra migrar pro header.
  if (!headerLicense && queryLicense && !_queryParamWarned) {
    logger.warn(
      "[licenseAuth] license token recebido via query string (?license=) — " +
      "DEPRECATED: credencial fica exposta em logs de proxy/CDN. " +
      "Migrar cliente pro header x-license-token.",
    );
    _queryParamWarned = true;
  }
  const license = headerLicense || queryLicense;
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
