/**
 * Bash Sandbox — Unit Tests
 */

import { describe, it, expect } from 'vitest';
import { validateBashCommand } from '../../src/tenancy/bashSandbox.js';

describe('Bash Sandbox', () => {
  describe('Admin (unrestricted)', () => {
    it('allows any command for admin', () => {
      expect(validateBashCommand('pm2 restart clow', '/tmp', true).allowed).toBe(true);
      expect(validateBashCommand('rm -rf /', '/tmp', true).allowed).toBe(true);
      expect(validateBashCommand('cat .env', '/tmp', true).allowed).toBe(true);
    });
  });

  describe('Regular User (sandboxed)', () => {
    it('allows whitelisted commands', () => {
      expect(validateBashCommand('ls -la', '/tmp', false).allowed).toBe(true);
      expect(validateBashCommand('node script.js', '/tmp', false).allowed).toBe(true);
      expect(validateBashCommand('npm install express', '/tmp', false).allowed).toBe(true);
      expect(validateBashCommand('git status', '/tmp', false).allowed).toBe(true);
      expect(validateBashCommand('curl https://api.example.com', '/tmp', false).allowed).toBe(true);
      expect(validateBashCommand('python3 script.py', '/tmp', false).allowed).toBe(true);
    });

    it('blocks pm2', () => {
      expect(validateBashCommand('pm2 restart clow', '/tmp', false).allowed).toBe(false);
      expect(validateBashCommand('pm2 status', '/tmp', false).allowed).toBe(false);
    });

    it('blocks sudo', () => {
      expect(validateBashCommand('sudo rm -rf /', '/tmp', false).allowed).toBe(false);
    });

    it('blocks .env access', () => {
      expect(validateBashCommand('cat .env', '/tmp', false).allowed).toBe(false);
      expect(validateBashCommand('grep API_KEY .env', '/tmp', false).allowed).toBe(false);
    });

    it('blocks system paths', () => {
      expect(validateBashCommand('cat /etc/passwd', '/tmp', false).allowed).toBe(false);
      expect(validateBashCommand('ls /opt/system-clow/src/server/', '/tmp', false).allowed).toBe(false);
    });

    it('blocks systemctl', () => {
      expect(validateBashCommand('systemctl restart nginx', '/tmp', false).allowed).toBe(false);
    });

    it('blocks SSH', () => {
      expect(validateBashCommand('ssh root@server', '/tmp', false).allowed).toBe(false);
    });

    it('allows piped whitelisted commands', () => {
      expect(validateBashCommand('ls -la | grep test', '/tmp', false).allowed).toBe(true);
      expect(validateBashCommand('cat file.txt | sort | uniq', '/tmp', false).allowed).toBe(true);
    });

    it('blocks piped dangerous commands', () => {
      expect(validateBashCommand('ls | sudo rm', '/tmp', false).allowed).toBe(false);
    });

    it('blocks empty commands', () => {
      expect(validateBashCommand('', '/tmp', false).allowed).toBe(false);
    });
  });
});
