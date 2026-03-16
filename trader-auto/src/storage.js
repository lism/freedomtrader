import fs from 'node:fs/promises';
import path from 'node:path';

const EMPTY_STATE = {
  seenTokens: {},
  positions: [],
};

export class RuntimeStorage {
  constructor(file) {
    this.file = file;
    this.state = structuredClone(EMPTY_STATE);
  }

  async load() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = {
        seenTokens: parsed.seenTokens || {},
        positions: Array.isArray(parsed.positions) ? parsed.positions : [],
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.save();
    }
    return this.state;
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.state, null, 2));
  }

  hasSeen(token) {
    return !!this.state.seenTokens[token.toLowerCase()];
  }

  async markSeen(token) {
    this.state.seenTokens[token.toLowerCase()] = Date.now();
    await this.save();
  }

  getOpenPositions() {
    return this.state.positions.filter((item) => item.status === 'open');
  }

  async addPosition(position) {
    this.state.positions.push(position);
    await this.save();
  }

  async updatePosition(token, patch) {
    const entry = this.state.positions.find((item) => item.token.toLowerCase() === token.toLowerCase() && item.status === 'open');
    if (!entry) return null;
    Object.assign(entry, patch);
    await this.save();
    return entry;
  }
}
