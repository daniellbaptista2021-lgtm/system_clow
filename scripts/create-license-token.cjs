const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
if (args.length < 3) {
  console.log("Usage: node create-license-token.js <tenantId> <email> <plan> [daysValid]");
  console.log("Plans: starter, pro, business, enterprise");
  console.log("Example: node create-license-token.js tenant_001 user@email.com pro 30");
  process.exit(1);
}

const [tenantId, email, plan] = args;
const daysValid = parseInt(args[3] || "30", 10);

const privateKeyPath = path.join(process.cwd(), ".license-private.key");
const privateKey = fs.readFileSync(privateKeyPath, "utf-8");

const payload = {
  tenantId,
  email,
  plan,
  expiresAt: Date.now() + daysValid * 24 * 60 * 60 * 1000,
  issuedAt: Date.now(),
};

const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64");
const sign = crypto.createSign("sha256");
sign.update(payloadB64);
const signature = sign.sign(privateKey, "base64");

const token = payloadB64 + "." + signature;

console.log("License Token Generated");
console.log("Tenant:", tenantId);
console.log("Email:", email);
console.log("Plan:", plan);
console.log("Valid for:", daysValid, "days");
console.log("Expires:", new Date(payload.expiresAt).toISOString());
console.log("");
console.log("TOKEN:");
console.log(token);
