import { createHmac, timingSafeEqual } from "node:crypto";

export const CRM_SESSAO_MS = 120_000;
export type CredencialCrm = {
  iss: "territorio-proprio";
  aud: "system-clow";
  scope: "provision" | "session";
  sub: string;
  email: string;
  name: string;
  tid?: string;
  iat: number;
  exp: number;
};

export function emitirCredencialCrm(
  pessoa: Pick<CredencialCrm, "sub" | "email" | "name" | "tid">,
  scope: CredencialCrm["scope"],
  segredo = process.env.CRM_TERRITORIO_SECRET || "",
  agora = Date.now(),
): string {
  if (segredo.length < 32) throw new Error("CRM não configurado");
  const payload: CredencialCrm = {
    ...pessoa, iss: "territorio-proprio", aud: "system-clow", scope,
    iat: agora, exp: agora + (scope === "session" ? CRM_SESSAO_MS : 60_000),
  };
  const corpo = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `tp.${corpo}.${createHmac("sha256", segredo).update(corpo).digest("base64url")}`;
}

export function conferirCredencialCrm(token: string, segredo = process.env.CRM_TERRITORIO_SECRET || "", agora = Date.now()): CredencialCrm | null {
  try {
    if (segredo.length < 32 || token.length > 8192) return null;
    const partes = token.split(".");
    if (partes.length !== 3 || partes[0] !== "tp") return null;
    const [, corpo, mac] = partes;
    const esperado = createHmac("sha256", segredo).update(corpo).digest("base64url");
    if (mac.length !== esperado.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(esperado))) return null;
    const p = JSON.parse(Buffer.from(corpo, "base64url").toString()) as CredencialCrm;
    if (p.iss !== "territorio-proprio" || p.aud !== "system-clow" || !["session", "provision"].includes(p.scope)) return null;
    if (!Number.isSafeInteger(p.exp) || !Number.isSafeInteger(p.iat) || p.exp <= agora || p.iat > agora + 5000 || p.exp - p.iat > CRM_SESSAO_MS || p.exp <= p.iat) return null;
    if (typeof p.sub !== "string" || !/^[0-9a-f-]{36}$/i.test(p.sub) || typeof p.email !== "string" || !p.email.includes("@") || typeof p.name !== "string") return null;
    if (p.scope === "session" && (typeof p.tid !== "string" || !p.tid)) return null;
    return p;
  } catch { return null; }
}
