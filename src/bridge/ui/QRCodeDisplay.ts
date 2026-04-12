/**
 * QRCodeDisplay.ts — Generate and display QR code for pairing
 *
 * Generates a text-based QR code that can be displayed in the terminal
 * for mobile device pairing.
 */

// ════════════════════════════════════════════════════════════════════════════
// QR Code Display
// ════════════════════════════════════════════════════════════════════════════

/**
 * Generate a simple text-based representation of a pairing URL.
 * In production, this would use a QR code library like 'qrcode-terminal'.
 * For now, displays the URL prominently.
 */
export function displayPairingQR(url: string): string {
  const lines: string[] = [];
  const border = '═'.repeat(Math.max(url.length + 4, 40));

  lines.push(`╔${border}╗`);
  lines.push(`║  SCAN TO PAIR${' '.repeat(Math.max(0, border.length - 14))}║`);
  lines.push(`╠${border}╣`);
  lines.push(`║  ${url}${' '.repeat(Math.max(0, border.length - url.length - 2))}║`);
  lines.push(`╚${border}╝`);
  lines.push('');
  lines.push('Open this URL on your mobile device to connect.');
  lines.push('The bridge will activate once pairing is complete.');

  return lines.join('\n');
}

/**
 * Generate a pairing URL from environment ID and endpoint.
 */
export function buildPairingUrl(endpointUrl: string, environmentId: string): string {
  const base = endpointUrl.replace(/\/api$/, '').replace(/\/$/, '');
  return `${base}/pair/${environmentId}`;
}

/**
 * Generate a short pairing code from environment ID.
 * Used for manual entry on devices without camera.
 */
export function generatePairingCode(environmentId: string): string {
  // Take first 6 chars, uppercase, with dash in middle
  const code = environmentId.replace(/-/g, '').slice(0, 6).toUpperCase();
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

/**
 * Display pairing info in terminal.
 */
export function displayPairingInfo(params: {
  endpointUrl: string;
  environmentId: string;
  showQR?: boolean;
}): string {
  const url = buildPairingUrl(params.endpointUrl, params.environmentId);
  const code = generatePairingCode(params.environmentId);
  const lines: string[] = [];

  if (params.showQR) {
    lines.push(displayPairingQR(url));
    lines.push('');
  }

  lines.push(`Pairing URL: ${url}`);
  lines.push(`Pairing Code: ${code}`);
  lines.push(`Environment: ${params.environmentId}`);

  return lines.join('\n');
}
