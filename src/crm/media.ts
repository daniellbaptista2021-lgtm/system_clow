/**
 * Media storage — save inbound/outbound media to local disk.
 *
 * Layout: ~/.clow/crm-media/{tenant_id}/{yyyy-mm-dd}/{id}.{ext}
 *
 * Served via: GET /v1/crm/media/:tenantId/:date/:filename
 * (auth checked at route — only owning tenant can read)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import type { MediaType } from './types.js';

function getMediaRoot(): string {
  const home = process.env.CLOW_HOME || path.join(os.homedir(), '.clow');
  const root = path.join(home, 'crm-media');
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  return root;
}

function todayFolder(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function extFromMime(mime?: string, fallback: MediaType = 'document'): string {
  if (!mime) return fallback === 'audio' ? 'ogg' : fallback === 'image' ? 'jpg' : fallback === 'video' ? 'mp4' : 'bin';
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv',
    'application/pdf': 'pdf', 'application/zip': 'zip',
    'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/plain': 'txt', 'text/csv': 'csv',
  };
  if (map[mime]) return map[mime];
  // Fallback: take from mime subtype
  const sub = mime.split('/')[1] || 'bin';
  return sub.split(';')[0].slice(0, 8);
}

export interface SavedMedia {
  id: string;
  tenantId: string;
  relativePath: string; // {date}/{filename}
  filename: string;
  mime?: string;
  bytes: number;
  publicUrl: string; // /v1/crm/media/{tenantId}/{date}/{filename}
}

export function saveMedia(tenantId: string, bytes: Buffer, opts: {
  mime?: string; mediaType?: MediaType; suggestedFilename?: string;
}): SavedMedia {
  const root = getMediaRoot();
  const date = todayFolder();
  const dir = path.join(root, tenantId, date);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const id = randomUUID().replace(/-/g, '').slice(0, 16);
  const ext = opts.suggestedFilename?.includes('.')
    ? opts.suggestedFilename.split('.').pop()!.toLowerCase().slice(0, 6)
    : extFromMime(opts.mime, opts.mediaType || 'document');
  const filename = `${id}.${ext}`;
  const fp = path.join(dir, filename);

  fs.writeFileSync(fp, bytes);
  return {
    id, tenantId,
    relativePath: `${date}/${filename}`,
    filename,
    mime: opts.mime,
    bytes: bytes.length,
    publicUrl: `/v1/crm/media/${tenantId}/${date}/${filename}`,
  };
}

export function readMedia(tenantId: string, date: string, filename: string): { bytes: Buffer; mime: string } | null {
  // Sanity: prevent path traversal
  if (!/^[\w-]{1,32}$/.test(date) || !/^[\w.-]{1,80}$/.test(filename)) return null;
  const fp = path.join(getMediaRoot(), tenantId, date, filename);
  if (!fp.startsWith(getMediaRoot())) return null; // belt-and-suspenders
  if (!fs.existsSync(fp)) return null;
  const bytes = fs.readFileSync(fp);
  const ext = path.extname(filename).toLowerCase().slice(1);
  const mime = mimeFromExt(ext);
  return { bytes, mime };
}

function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
    ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
    mp4: 'video/mp4', webm: 'video/webm',
    pdf: 'application/pdf', zip: 'application/zip',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    txt: 'text/plain', csv: 'text/csv', json: 'application/json',
  };
  return map[ext] || 'application/octet-stream';
}
