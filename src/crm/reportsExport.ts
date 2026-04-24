/**
 * CRM Reports export — CSV + PDF helpers.
 *
 * Tabular reports get consistent column mapping per report type.
 * CSV: RFC 4180-ish (quoted fields, \r\n, BOM for Excel UTF-8).
 * PDF: pdfkit with a minimal header/body table layout.
 */

import PDFDocument from 'pdfkit';

export type ReportKind = 'sales' | 'agents' | 'sources' | 'lost-reasons';

function col(value: unknown): string {
  if (value == null) return '';
  const s = String(value);
  if (/[,"\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function toCSV(kind: ReportKind, rows: any[]): string {
  let headers: string[];
  let pick: (r: any) => unknown[];
  switch (kind) {
    case 'sales':
      headers = ['bucket', 'bucketStart', 'dealsWon', 'totalValueCents', 'avgDealValueCents'];
      pick = r => [r.bucket, r.bucketStart, r.dealsWon, r.totalValueCents, r.avgDealValueCents];
      break;
    case 'agents':
      headers = ['agentId', 'agentName', 'totalActivities', 'byType'];
      pick = r => [r.agentId, r.agentName, r.totalActivities, JSON.stringify(r.byType)];
      break;
    case 'sources':
      headers = ['source', 'contactCount', 'cardsOpen', 'cardsWon', 'cardsLost', 'conversionRate', 'totalRevenueCents'];
      pick = r => [r.source, r.contactCount, r.cardsOpen, r.cardsWon, r.cardsLost, (r.conversionRate * 100).toFixed(2) + '%', r.totalRevenueCents];
      break;
    case 'lost-reasons':
      headers = ['reason', 'cardCount', 'totalValueLostCents', 'avgValueLostCents'];
      pick = r => [r.reason, r.cardCount, r.totalValueLostCents, r.avgValueLostCents];
      break;
  }
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(pick(r).map(col).join(','));
  // BOM so Excel detects UTF-8
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export async function toPDF(kind: ReportKind, rows: any[], meta: { title: string; subtitle?: string }): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 40, size: 'A4' });
      const bufs: Buffer[] = [];
      doc.on('data', (b: Buffer) => bufs.push(b));
      doc.on('end', () => resolve(Buffer.concat(bufs)));
      doc.on('error', reject);

      // Header
      doc.fontSize(18).fillColor('#9B59FC').text(meta.title, { align: 'left' });
      if (meta.subtitle) doc.fontSize(10).fillColor('#666').text(meta.subtitle);
      doc.moveDown();
      doc.fontSize(9).fillColor('#999').text(`Gerado em ${new Date().toISOString()}`);
      doc.moveDown(1.2);

      // Table
      const { headers, mapper } = tableSpec(kind);
      const colWidth = (doc.page.width - 80) / headers.length;
      const startX = 40;
      let y = doc.y;

      // Header row
      doc.fontSize(10).fillColor('#000').font('Helvetica-Bold');
      headers.forEach((h, i) => doc.text(h, startX + i * colWidth, y, { width: colWidth - 4, ellipsis: true }));
      y += 18;
      doc.moveTo(startX, y - 4).lineTo(doc.page.width - 40, y - 4).strokeColor('#ddd').stroke();

      // Body rows
      doc.font('Helvetica').fontSize(9).fillColor('#333');
      for (const r of rows) {
        const vals = mapper(r);
        if (y > doc.page.height - 60) { doc.addPage(); y = 40; }
        vals.forEach((v, i) => doc.text(String(v ?? ''), startX + i * colWidth, y, { width: colWidth - 4, ellipsis: true }));
        y += 16;
      }

      // Footer summary
      if (rows.length === 0) {
        doc.moveDown(2).fontSize(10).fillColor('#999').text('Nenhum dado no período selecionado.', { align: 'center' });
      } else {
        doc.moveDown(2).fontSize(9).fillColor('#666').text(`Total de registros: ${rows.length}`, startX, y + 10);
      }

      doc.end();
    } catch (e) { reject(e); }
  });
}

function tableSpec(kind: ReportKind): { headers: string[]; mapper: (r: any) => string[] } {
  switch (kind) {
    case 'sales':
      return {
        headers: ['Período', 'Vendas', 'Total (R$)', 'Ticket médio (R$)'],
        mapper: r => [r.bucket, String(r.dealsWon), brl(r.totalValueCents), brl(r.avgDealValueCents)],
      };
    case 'agents':
      return {
        headers: ['Agente', 'Atividades', 'Top tipo'],
        mapper: r => {
          const top = Object.entries(r.byType).sort((a: any, b: any) => b[1] - a[1])[0];
          return [r.agentName, String(r.totalActivities), top ? `${top[0]} (${top[1]})` : '—'];
        },
      };
    case 'sources':
      return {
        headers: ['Origem', 'Contatos', 'Abertos', 'Ganhos', 'Perdidos', 'Conv.', 'Receita (R$)'],
        mapper: r => [
          r.source, String(r.contactCount), String(r.cardsOpen), String(r.cardsWon),
          String(r.cardsLost), (r.conversionRate * 100).toFixed(1) + '%', brl(r.totalRevenueCents),
        ],
      };
    case 'lost-reasons':
      return {
        headers: ['Razão', 'Cards', 'Total perdido (R$)', 'Médio (R$)'],
        mapper: r => [r.reason, String(r.cardCount), brl(r.totalValueLostCents), brl(r.avgValueLostCents)],
      };
  }
}

function brl(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
