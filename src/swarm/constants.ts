/**
 * constants.ts — Agent Swarms constants
 */

// ─── Directory Names ────────────────────────────────────────────────────────

export const TEAM_LEAD_NAME = 'team-lead';
export const TEAMS_DIR_NAME = 'teams';
export const INBOXES_DIR_NAME = 'inboxes';
export const TASKS_DIR_NAME = 'tasks';

// ─── Mailbox ────────────────────────────────────────────────────────────────

export const MAILBOX_LOCK_RETRIES = 10;
export const MAILBOX_LOCK_MIN_TIMEOUT_MS = 5;
export const MAILBOX_LOCK_MAX_TIMEOUT_MS = 100;
export const MAILBOX_POLL_INTERVAL_MS = 500;
export const MAILBOX_MAX_SIZE = 1000;
export const MAILBOX_STALE_LOCK_MS = 30_000;

// ─── Backends ───────────────────────────────────────────────────────────────

export const TMUX_SOCKET_PREFIX = 'clow-swarm';
export const ITERM_TAB_PREFIX = 'clow-';

// ─── Team Name Generation ───────────────────────────────────────────────────

export const TEAM_NAME_WORDS = [
  'atlas', 'nova', 'phoenix', 'orion', 'pegasus',
  'aurora', 'vega', 'lyra', 'eos', 'titan',
  'nebula', 'cosmos', 'zenith', 'apex', 'prism',
];

export const DEFAULT_MEMBER_COLORS = [
  '#4A90D9', '#E67E22', '#27AE60', '#8E44AD',
  '#F39C12', '#16A085', '#E74C3C', '#3498DB',
];

// ─── Limits ─────────────────────────────────────────────────────────────────

export const MAX_TEAM_MEMBERS = 10;
export const MAX_TEAMS = 20;
export const MAX_PANE_TITLE_LENGTH = 50;
export const SPAWN_TIMEOUT_MS = 30_000;
export const SHUTDOWN_TIMEOUT_MS = 10_000;
export const PERMISSION_TIMEOUT_MS = 120_000;
