#!/usr/bin/env node
/**
 * Gera o bcrypt hash da senha de admin pra usar em CLOW_ADMIN_PASS_HASH.
 *
 * Uso:
 *   node scripts/hash-admin-pass.cjs 'MinhaSenhaForte'
 *
 * Depois, no .env:
 *   CLOW_ADMIN_PASS_HASH='<hash gerado>'
 *   # e REMOVER a linha CLOW_ADMIN_PASS=
 */
const bcrypt = require('bcryptjs');

const pass = process.argv[2];
if (!pass) {
  console.error("Uso: node scripts/hash-admin-pass.cjs 'SuaSenha'");
  process.exit(1);
}

const hash = bcrypt.hashSync(pass, 12);
console.log('Adicione ao .env (use aspas simples — o hash contem $):');
console.log(`CLOW_ADMIN_PASS_HASH='${hash}'`);
console.log('E remova a linha CLOW_ADMIN_PASS=');
