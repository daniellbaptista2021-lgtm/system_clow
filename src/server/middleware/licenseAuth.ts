import type { Context, Next } from "hono";
import { getLicenseValidator } from "../../tenancy/licenseValidator.js";

export async function licenseAuthMiddleware(c: Context, next: Next) {
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
