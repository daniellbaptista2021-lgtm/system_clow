/** Track discovered skills across session for reinjection after compact. */

export class DiscoveredSkillsTracker {
  private skills = new Set<string>();
  add(name: string): void { this.skills.add(name); }
  addMany(names: string[]): void { for (const n of names) this.skills.add(n); }
  has(name: string): boolean { return this.skills.has(name); }
  size(): number { return this.skills.size; }
  toArray(): string[] { return [...this.skills]; }
  merge(other: Set<string>): Set<string> { const m = new Set(this.skills); for (const i of other) m.add(i); return m; }
  clear(): void { this.skills.clear(); }
  serialize(): string { return JSON.stringify([...this.skills]); }
  static deserialize(json: string): DiscoveredSkillsTracker { const t = new DiscoveredSkillsTracker(); t.addMany(JSON.parse(json)); return t; }
}
