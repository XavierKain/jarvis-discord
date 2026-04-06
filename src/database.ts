import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import path from "path";

const DB_PATH = path.join(import.meta.dir, "..", "data", "jarvis.db");

mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    channel_id TEXT PRIMARY KEY,
    channel_name TEXT NOT NULL,
    session_id TEXT,
    project_dir TEXT NOT NULL,
    last_activity INTEGER DEFAULT 0,
    message_count INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS memory (
    channel_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (channel_id, created_at)
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    session_id TEXT,
    cost_usd REAL DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    num_turns INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    model TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS channel_settings (
    channel_name TEXT PRIMARY KEY,
    max_turns INTEGER,
    model TEXT,
    compact_threshold INTEGER,
    streaming INTEGER,
    system_prompt TEXT,
    project_dir TEXT,
    updated_at INTEGER DEFAULT (unixepoch())
  );
`);

// Prepared statements
const stmts = {
  getSession: db.prepare("SELECT * FROM sessions WHERE channel_id = ?"),
  upsertSession: db.prepare(`
    INSERT INTO sessions (channel_id, channel_name, session_id, project_dir, last_activity, message_count)
    VALUES (?, ?, ?, ?, ?, 0)
    ON CONFLICT(channel_id) DO UPDATE SET
      session_id = excluded.session_id,
      last_activity = excluded.last_activity,
      updated_at = unixepoch()
  `),
  updateSessionId: db.prepare(`
    UPDATE sessions SET session_id = ?, last_activity = ?, updated_at = unixepoch()
    WHERE channel_id = ?
  `),
  incrementMessageCount: db.prepare(`
    UPDATE sessions SET message_count = message_count + 1, last_activity = ?, updated_at = unixepoch()
    WHERE channel_id = ?
  `),
  resetMessageCount: db.prepare(`
    UPDATE sessions SET message_count = 0, updated_at = unixepoch()
    WHERE channel_id = ?
  `),
  getMessageCount: db.prepare("SELECT message_count FROM sessions WHERE channel_id = ?"),

  // Memory
  saveMemory: db.prepare("INSERT INTO memory (channel_id, summary) VALUES (?, ?)"),
  getMemories: db.prepare(
    "SELECT summary, created_at FROM memory WHERE channel_id = ? ORDER BY created_at DESC LIMIT 5"
  ),

  // Activity log (for #général)
  logActivity: db.prepare(
    "INSERT INTO activity_log (channel_id, channel_name, event_type, summary) VALUES (?, ?, ?, ?)"
  ),
  getRecentActivity: db.prepare(
    "SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 20"
  ),
  getActivitySince: db.prepare(
    "SELECT * FROM activity_log WHERE created_at > ? ORDER BY created_at DESC"
  ),

  // Usage tracking
  logUsage: db.prepare(`
    INSERT INTO usage_log (channel_id, channel_name, session_id, cost_usd, duration_ms, num_turns, input_tokens, output_tokens, cache_read_tokens, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getCostsByChannel: db.prepare(`
    SELECT channel_name, SUM(cost_usd) as total_cost, COUNT(*) as sessions, SUM(num_turns) as total_turns,
           SUM(input_tokens) as total_input, SUM(output_tokens) as total_output
    FROM usage_log WHERE created_at > ? GROUP BY channel_name ORDER BY total_cost DESC
  `),
  getTotalCosts: db.prepare(`
    SELECT SUM(cost_usd) as total_cost, COUNT(*) as sessions, SUM(num_turns) as total_turns
    FROM usage_log WHERE created_at > ?
  `),
  getDailyCosts: db.prepare(`
    SELECT date(created_at, 'unixepoch') as day, SUM(cost_usd) as cost, COUNT(*) as sessions
    FROM usage_log GROUP BY day ORDER BY day DESC LIMIT 14
  `),

  // Channel settings (runtime overrides)
  getChannelSetting: db.prepare("SELECT * FROM channel_settings WHERE channel_name = ?"),
  getAllChannelSettings: db.prepare("SELECT * FROM channel_settings ORDER BY channel_name"),
  upsertChannelSetting: db.prepare(`
    INSERT INTO channel_settings (channel_name, max_turns, model, compact_threshold, streaming, system_prompt, project_dir, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(channel_name) DO UPDATE SET
      max_turns = COALESCE(excluded.max_turns, max_turns),
      model = COALESCE(excluded.model, model),
      compact_threshold = COALESCE(excluded.compact_threshold, compact_threshold),
      streaming = COALESCE(excluded.streaming, streaming),
      system_prompt = COALESCE(excluded.system_prompt, system_prompt),
      project_dir = COALESCE(excluded.project_dir, project_dir),
      updated_at = unixepoch()
  `),
  deleteChannelSetting: db.prepare("DELETE FROM channel_settings WHERE channel_name = ?"),
};

export function getSession(channelId: string) {
  return stmts.getSession.get(channelId) as any;
}

export function upsertSession(channelId: string, channelName: string, sessionId: string | null, projectDir: string) {
  stmts.upsertSession.run(channelId, channelName, sessionId, projectDir, Date.now());
}

export function updateSessionId(channelId: string, sessionId: string) {
  stmts.updateSessionId.run(sessionId, Date.now(), channelId);
}

export function incrementMessageCount(channelId: string) {
  stmts.incrementMessageCount.run(Date.now(), channelId);
}

export function resetMessageCount(channelId: string) {
  stmts.resetMessageCount.run(channelId);
}

export function getMessageCount(channelId: string): number {
  const row = stmts.getMessageCount.get(channelId) as any;
  return row?.message_count || 0;
}

export function saveMemory(channelId: string, summary: string) {
  stmts.saveMemory.run(channelId, summary);
}

export function getMemories(channelId: string) {
  return stmts.getMemories.all(channelId) as { summary: string; created_at: number }[];
}

export function logActivity(channelId: string, channelName: string, eventType: string, summary: string) {
  stmts.logActivity.run(channelId, channelName, eventType, summary);
}

export function getRecentActivity() {
  return stmts.getRecentActivity.all() as any[];
}

export function getActivitySince(since: number) {
  return stmts.getActivitySince.all(since) as any[];
}

// Usage tracking
export function logUsage(
  channelId: string, channelName: string, sessionId: string | null,
  costUsd: number, durationMs: number, numTurns: number,
  inputTokens: number, outputTokens: number, cacheReadTokens: number, model: string | null
) {
  stmts.logUsage.run(channelId, channelName, sessionId, costUsd, durationMs, numTurns, inputTokens, outputTokens, cacheReadTokens, model);
}

export function getCostsByChannel(since: number) {
  return stmts.getCostsByChannel.all(since) as any[];
}

export function getTotalCosts(since: number) {
  return stmts.getTotalCosts.get(since) as any;
}

export function getDailyCosts() {
  return stmts.getDailyCosts.all() as any[];
}

// Channel settings
export function getChannelSetting(channelName: string) {
  return stmts.getChannelSetting.get(channelName) as any;
}

export function getAllChannelSettings() {
  return stmts.getAllChannelSettings.all() as any[];
}

export function upsertChannelSetting(
  channelName: string,
  settings: { max_turns?: number | null; model?: string | null; compact_threshold?: number | null; streaming?: number | null; system_prompt?: string | null; project_dir?: string | null }
) {
  stmts.upsertChannelSetting.run(
    channelName,
    settings.max_turns ?? null,
    settings.model ?? null,
    settings.compact_threshold ?? null,
    settings.streaming ?? null,
    settings.system_prompt ?? null,
    settings.project_dir ?? null,
  );
}

export function deleteChannelSetting(channelName: string) {
  stmts.deleteChannelSetting.run(channelName);
}

export default db;
