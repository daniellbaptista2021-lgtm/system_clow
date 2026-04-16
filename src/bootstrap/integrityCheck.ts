import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export class IntegrityChecker {
  private expectedHash: string | null = null;

  constructor() {
    try {
      this.expectedHash = fs.readFileSync(path.join(process.cwd(), ".integrity-hash"), "utf-8").trim();
    } catch {
      // Development mode — no integrity check
    }
  }

  verify(): boolean {
    if (!this.expectedHash) return true;

    const coreFiles = [
      "dist/server/server.js",
      "dist/server/routes.js",
      "dist/tenancy/licenseValidator.js",
    ];

    const hash = crypto.createHash("sha256");
    for (const file of coreFiles) {
      try {
        hash.update(fs.readFileSync(path.join(process.cwd(), file)));
      } catch {
        return false;
      }
    }

    const currentHash = hash.digest("hex");
    if (currentHash !== this.expectedHash) {
      console.error("INTEGRITY CHECK FAILED — System files have been modified");
      return false;
    }
    return true;
  }

  static generateHash(): string {
    const coreFiles = [
      "dist/server/server.js",
      "dist/server/routes.js",
      "dist/tenancy/licenseValidator.js",
    ];
    const hash = crypto.createHash("sha256");
    for (const file of coreFiles) {
      try {
        hash.update(fs.readFileSync(path.join(process.cwd(), file)));
      } catch {}
    }
    return hash.digest("hex");
  }
}
