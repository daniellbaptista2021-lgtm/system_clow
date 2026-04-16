const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Generate RSA key pair
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

const privateKeyPath = path.join(process.cwd(), ".license-private.key");
const publicKeyPath = path.join(process.cwd(), ".license-public.key");

fs.writeFileSync(privateKeyPath, privateKey.export({ format: "pem", type: "pkcs8" }));
fs.writeFileSync(publicKeyPath, publicKey.export({ format: "pem", type: "spki" }));

console.log("License keys generated");
console.log("KEEP .license-private.key SECRET");
console.log("Private:", privateKeyPath);
console.log("Public:", publicKeyPath);
