import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  installCodeModeSkill,
  uninstallCodeModeSkill,
  writeCodeModeTokenFile,
  skillFilePath,
  skillDirPath,
  SKILL_NAME,
} from './skill-install.js';
import { codeModeTokenFilePath } from './workspace-gen.js';

const PORT = 47284;
const TOKEN = 'a'.repeat(64);

describe('skill-install', () => {
  let home: string;
  let workspaceDir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sentinel-skill-home-'));
    workspaceDir = mkdtempSync(join(tmpdir(), 'sentinel-skill-ws-'));
    prevHome = process.env.SENTINEL_TEST_HOME;
    process.env.SENTINEL_TEST_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.SENTINEL_TEST_HOME;
    else process.env.SENTINEL_TEST_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('writes SKILL.md under ~/.claude/skills with frontmatter naming the bridged servers', async () => {
    const path = await installCodeModeSkill({
      servers: ['github', 'mongodb-mcp-server'],
      port: PORT,
      dir: workspaceDir,
    });
    expect(path).toBe(join(home, '.claude', 'skills', SKILL_NAME, 'SKILL.md'));
    const content = readFileSync(path, 'utf-8');
    expect(content).toMatch(/^---\nname: sentinel-code-mode\n/);
    expect(content).toContain('github, mongodb-mcp-server');
    expect(content).toContain(`http://127.0.0.1:${PORT}/code-mode/call`);
    expect(content).toContain(join(workspaceDir, 'servers'));
    expect(content).toContain('Never print the contents of the token file.');
  });

  it('references the token strictly via $(cat <file>) and never inlines it', async () => {
    await writeCodeModeTokenFile(TOKEN, workspaceDir);
    const path = await installCodeModeSkill({ servers: ['github'], port: PORT, dir: workspaceDir });
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain(`$(cat ${codeModeTokenFilePath(workspaceDir)})`);
    expect(content).not.toContain(TOKEN);
    // No 64-hex-char run anywhere in the skill text.
    expect(content).not.toMatch(/[0-9a-f]{64}/);
  });

  it('writes the token file with 0600 perms and trailing newline for $(cat)', async () => {
    const path = await writeCodeModeTokenFile(TOKEN, workspaceDir);
    expect(path).toBe(codeModeTokenFilePath(workspaceDir));
    expect(readFileSync(path, 'utf-8')).toBe(`${TOKEN}\n`);
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it('is idempotent: reinstall rewrites the skill to the new server set', async () => {
    await installCodeModeSkill({ servers: ['github'], port: PORT, dir: workspaceDir });
    await installCodeModeSkill({ servers: ['github', 'shopify'], port: PORT, dir: workspaceDir });
    const content = readFileSync(skillFilePath(), 'utf-8');
    expect(content).toContain('github, shopify');
  });

  it('uninstall removes the skill dir and the token file', async () => {
    await writeCodeModeTokenFile(TOKEN, workspaceDir);
    await installCodeModeSkill({ servers: ['github'], port: PORT, dir: workspaceDir });
    expect(existsSync(skillDirPath())).toBe(true);
    await uninstallCodeModeSkill(workspaceDir);
    expect(existsSync(skillDirPath())).toBe(false);
    expect(existsSync(codeModeTokenFilePath(workspaceDir))).toBe(false);
    // Idempotent on a second call.
    await uninstallCodeModeSkill(workspaceDir);
    expect(existsSync(skillDirPath())).toBe(false);
  });
});
