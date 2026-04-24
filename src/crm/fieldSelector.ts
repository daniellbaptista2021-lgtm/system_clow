/**
 * Field selection (sparse fieldsets) — Onda 30.
 *
 * Usage:
 *   GET /v1/crm/contacts?fields=id,name,email
 *   → returns only those keys in each contact object.
 *
 * Helper: pickFields(obj, fields) — nested paths with dot notation support.
 */

export function pickFields<T extends Record<string, any>>(obj: T, fields: string[] | undefined | null): Partial<T> | T {
  if (!fields || fields.length === 0) return obj;
  const out: any = {};
  for (const field of fields) {
    if (field.includes('.')) {
      // Dot notation: user.email, customFields.company
      const parts = field.split('.');
      let src: any = obj;
      let dst = out;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (i === parts.length - 1) {
          if (src && p in src) dst[p] = src[p];
        } else {
          dst[p] = dst[p] || {};
          dst = dst[p];
          src = src?.[p];
        }
      }
    } else if (field in obj) {
      out[field] = obj[field];
    }
  }
  return out;
}

export function pickArray<T extends Record<string, any>>(items: T[], fields: string[] | undefined | null): Partial<T>[] {
  if (!fields || fields.length === 0) return items;
  return items.map(it => pickFields(it, fields));
}

export function parseFieldsParam(fieldsQuery: string | undefined | null): string[] | null {
  if (!fieldsQuery) return null;
  const arr = String(fieldsQuery).split(',').map(s => s.trim()).filter(Boolean);
  return arr.length > 0 ? arr : null;
}

/**
 * Hono middleware: auto-apply field selection to response JSON when ?fields= is present.
 * Works for responses where body is an object with one array key (e.g., { contacts: [...] }).
 */
export function fieldSelectionMiddleware() {
  return async (c: any, next: () => Promise<void>) => {
    await next();
    const fieldsQuery = c.req.query('fields');
    const fields = parseFieldsParam(fieldsQuery);
    if (!fields) return;

    // Only post-process JSON responses
    const ct = c.res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return;

    try {
      const data = await c.res.clone().json();
      // Walk top-level keys; if it's an array of objects, apply. If it's nested { items: [...] }, apply.
      const transformed: any = {};
      for (const [k, v] of Object.entries(data)) {
        if (Array.isArray(v)) transformed[k] = pickArray(v, fields);
        else if (v && typeof v === 'object' && !Array.isArray(v)) transformed[k] = pickFields(v, fields);
        else transformed[k] = v;
      }
      const newBody = JSON.stringify(transformed);
      c.res = new Response(newBody, {
        status: c.res.status,
        headers: c.res.headers,
      });
    } catch { /* non-JSON or parse error — leave as-is */ }
  };
}
