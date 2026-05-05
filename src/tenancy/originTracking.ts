import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

interface OriginEvent {
  id: string;
  timestamp: number;
  eventType: string;
  source: string;
  gitRemote?: string;
  hostname: string;
}

const EVENTS_FILE = path.join(os.homedir(), ".clow", "origin-events.jsonl");

function ensureDir(): void {
  const dir = path.dirname(EVENTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function trackInstallation(source: string, gitRemote?: string): void {
  try {
    ensureDir();
    const event: OriginEvent = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      eventType: "installation",
      source,
      gitRemote,
      hostname: os.hostname(),
    };
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + "\n");
  } catch {}
}

export function trackAccess(source: string, ip?: string): void {
  try {
    ensureDir();
    const event = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      eventType: "access",
      source,
      ip,
      hostname: os.hostname(),
    };
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + "\n");
  } catch {}
}

export function getOriginEvents(limit: number = 100): OriginEvent[] {
  try {
    if (!fs.existsSync(EVENTS_FILE)) return [];
    const lines = fs.readFileSync(EVENTS_FILE, "utf-8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map(l => JSON.parse(l)).reverse();
  } catch { return []; }
}
