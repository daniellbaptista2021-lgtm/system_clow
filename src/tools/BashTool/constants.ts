/** BashTool constants — limits, patterns, command sets */

export const COMMAND_DELIMITER = '__CLOW_CMD_DONE__';
export const OUTPUT_LIMIT_CHARS = 30_000;
export const HEAD_LINES = 50;
export const TAIL_LINES = 50;
export const DEFAULT_TIMEOUT_MS = 30 * 60_000; // 30 min
export const MAX_COMMAND_LENGTH = 10_000;

export const READ_ONLY_COMMANDS = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'less', 'more', 'echo',
  'date', 'whoami', 'id', 'uname', 'which', 'whereis', 'type',
  'file', 'stat', 'wc', 'sort', 'uniq', 'cut', 'awk', 'sed',
  'find', 'tree', 'du', 'df', 'free', 'ps', 'top', 'htop',
  'env', 'printenv', 'history', 'help', 'man', 'info',
  'true', 'false', 'test', 'expr', 'basename', 'dirname',
  'realpath', 'readlink', 'tput', 'tty', 'logname',
]);

export const READ_ONLY_GIT = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'remote', 'tag',
  'config', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree',
  'cat-file', 'describe', 'shortlog', 'reflog', 'blame',
]);

export const READ_ONLY_NPM = new Set([
  'list', 'ls', 'view', 'search', 'outdated', 'audit',
  'fund', 'doctor', 'whoami', 'help',
]);

export const DESTRUCTIVE_COMMANDS = new Set([
  'rm', 'rmdir', 'shred', 'wipefs', 'mkfs', 'fdisk', 'dd', 'truncate', 'unlink',
]);

export const NETWORK_COMMANDS = new Set([
  'curl', 'wget', 'nc', 'ncat', 'ssh', 'scp', 'rsync',
  'ftp', 'sftp', 'telnet', 'ping', 'traceroute', 'dig', 'nslookup',
]);

export const PRIVILEGED_COMMANDS = new Set([
  'sudo', 'su', 'doas', 'pkexec', 'systemctl', 'service',
  'mount', 'umount', 'iptables', 'ufw',
]);

/**
 * Commands that modify version control state.
 * These require write permission even in otherwise read-only contexts.
 */
export const VCS_WRITE_COMMANDS = new Set([
  'push', 'commit', 'merge', 'rebase', 'reset', 'checkout',
  'cherry-pick', 'revert', 'stash', 'pull', 'fetch', 'clone',
  'init', 'am', 'apply', 'bisect',
]);

/**
 * Package manager install commands that modify node_modules.
 * Classified separately as they are common and often safe.
 */
export const PACKAGE_INSTALL_COMMANDS = new Set([
  'install', 'add', 'remove', 'uninstall', 'update', 'upgrade',
  'ci', 'dedupe', 'prune', 'rebuild', 'link', 'unlink',
]);

/**
 * Maximum number of concurrent background processes.
 */
export const MAX_BACKGROUND_PROCESSES = 5;

/**
 * Time in ms before a background process is considered stale.
 */
export const BACKGROUND_PROCESS_STALE_MS = 30 * 60_000;

/**
 * Maximum output buffer size in bytes for a single command.
 */
export const MAX_OUTPUT_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Default shell to use for command execution.
 */
export const DEFAULT_SHELL = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';

/**
 * Environment variables that should be sanitized before passing to child processes.
 * These variables are removed from the environment to prevent credential leaks.
 */
export const SANITIZED_ENV_VARS = new Set([
  'AWS_SECRET_ACCESS_KEY',
  'GITHUB_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'DATABASE_URL',
  'PRIVATE_KEY',
]);
