import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export interface LicenseData {
  tenantId: string;
  email: string;
  plan: "starter" | "pro" | "business" | "enterprise";
  expiresAt: number;
  signature: string;
}

export class LicenseValidator {
  private publicKey: string | null = null;

  constructor() {
    try {
      this.publicKey = fs.readFileSync(path.join(process.cwd(), ".license-public.key"), "utf-8");
    } catch {
      // No key = development mode (admin-only access)
    }
  }

  validate(licenseToken: string): LicenseData {
    if (!this.publicKey) {
      throw new Error("License public key not found. System is in restricted mode.");
    }
    try {
      const [payload, signature] = licenseToken.split(".");
      const decoded = JSON.parse(Buffer.from(payload, "base64").toString()) as LicenseData;
      const verify = crypto.createVerify("sha256");
      verify.update(payload);
      if (!verify.verify(this.publicKey, signature, "base64")) {
        throw new Error("Invalid license signature");
      }
      if (decoded.expiresAt < Date.now()) {
        throw new Error("License expired");
      }
      return decoded;
    } catch (error: any) {
      throw new Error("License validation failed: " + error.message);
    }
  }

  isExpired(expiresAt: number): boolean {
    return expiresAt < Date.now();
  }

  isAvailable(): boolean {
    return this.publicKey !== null;
  }
}

let _instance: LicenseValidator | null = null;
export function getLicenseValidator(): LicenseValidator {
  if (!_instance) _instance = new LicenseValidator();
  return _instance;
}
