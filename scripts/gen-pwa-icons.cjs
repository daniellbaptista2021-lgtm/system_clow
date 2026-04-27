#!/usr/bin/env node
/**
 * gen-pwa-icons.cjs — gera os 4 ícones PWA limpos.
 *
 * Saída: public/assets/icon-{192,512}.png + icon-{192,512}-maskable.png
 *
 * Ícone "any":      fundo preto sólido + símbolo de infinito branco
 *                   ocupando ~70% da largura (centralizado).
 * Ícone "maskable": mesmo desenho mas com safe area de 20% (infinito
 *                   menor, ~50%) pra não cortar quando o launcher
 *                   aplicar máscara circular/superellipse.
 *
 * Roda com: node scripts/gen-pwa-icons.cjs
 */
const sharp = require('sharp');
const path = require('node:path');

const OUT = path.resolve(__dirname, '..', 'public', 'assets');
const BG = '#000000';
const FG = '#FFFFFF';

// Path do infinito centralizado em (cx, cy) com largura total = w.
// Mantém aspect ratio 2:1 (largura:altura). Stroke pintado pelo wrapper SVG.
function infinityPath(cx, cy, w) {
  const halfW = w / 2;
  const halfH = w / 4; // altura = w/2
  const x0 = cx - halfW;            // borda esquerda
  const x1 = cx;                    // centro
  const x2 = cx + halfW;            // borda direita
  const yTop = cy - halfH;
  const yBot = cy + halfH;
  // 4 curvas Bezier formando o lemniscato
  return [
    `M ${x0} ${cy}`,
    `C ${x0} ${yTop}, ${x1 - halfW * 0.33} ${yTop}, ${x1} ${cy}`,
    `C ${x1 + halfW * 0.33} ${yBot}, ${x2} ${yBot}, ${x2} ${cy}`,
    `C ${x2} ${yTop}, ${x1 + halfW * 0.33} ${yTop}, ${x1} ${cy}`,
    `C ${x1 - halfW * 0.33} ${yBot}, ${x0} ${yBot}, ${x0} ${cy}`,
    'Z',
  ].join(' ');
}

function buildSVG(size, opts = {}) {
  const maskable = !!opts.maskable;
  // 'any' usa 70% da largura, 'maskable' usa 50% (safe area de ~20% por borda)
  const widthPct = maskable ? 0.50 : 0.70;
  const w = size * widthPct;
  const cx = size / 2;
  const cy = size / 2;
  const stroke = Math.round(size * (maskable ? 0.055 : 0.075));
  const path = infinityPath(cx, cy, w);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${BG}"/>
  <path d="${path}" stroke="${FG}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>`;
}

async function emit(size, maskable) {
  const svg = buildSVG(size, { maskable });
  const suffix = maskable ? '-maskable' : '';
  const outPath = path.join(OUT, `icon-${size}${suffix}.png`);
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(outPath);
  console.log(`✓ ${outPath} (${size}x${size}, ${maskable ? 'maskable' : 'any'})`);
}

(async () => {
  await emit(192, false);
  await emit(512, false);
  await emit(192, true);
  await emit(512, true);
  // O 'icon-512-gold.png' e 'icon-192-gold.png' eram do tema antigo bege —
  // sobrescreve com a nova versao preta+branca pra nao ter inconsistencia.
  // O manifest aponta pra eles; trocar referência seria mais code change.
  for (const size of [192, 512]) {
    const svg = buildSVG(size, { maskable: false });
    await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(
      path.join(OUT, `icon-${size}-gold.png`),
    );
    console.log(`✓ icon-${size}-gold.png (overwritten)`);
  }
  console.log('\nDone — 6 PNGs gerados.');
})();
