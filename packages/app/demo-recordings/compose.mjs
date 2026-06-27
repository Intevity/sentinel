#!/usr/bin/env node
// Composite the bookends around an already-recorded app clip:
//   video-bookends/<slug>-intro.mp4 + out/<slug>-app.mp4 + <slug>-outro.mp4
//   -> out/<slug>.mp4   (the final site clip)
// Usage: node compose.mjs <slug> [<slug> ...]   (or no args = all out/*-app.mp4)
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOOKENDS = path.join(here, '..', '..', 'site', 'video-bookends');
const OUT = path.join(here, 'out');
const W = 1920,
  H = 1080,
  FPS = 30;

let slugs = process.argv.slice(2);
if (!slugs.length) {
  slugs = readdirSync(OUT)
    .filter((f) => f.endsWith('-app.mp4'))
    .map((f) => f.replace('-app.mp4', ''));
}

const norm = `fps=${FPS},scale=${W}:${H}:flags=lanczos,setsar=1`;
let failed = 0;
for (const slug of slugs) {
  const intro = path.join(BOOKENDS, `${slug}-intro.mp4`);
  const app = path.join(OUT, `${slug}-app.mp4`);
  const outro = path.join(BOOKENDS, `${slug}-outro.mp4`);
  const out = path.join(OUT, `${slug}.mp4`);
  if (![intro, app, outro].every(existsSync)) {
    console.log(
      `✗ ${slug}: missing input (intro:${existsSync(intro)} app:${existsSync(app)} outro:${existsSync(outro)})`,
    );
    failed++;
    continue;
  }
  const ok =
    spawnSync(
      'ffmpeg',
      [
        '-y',
        '-i',
        intro,
        '-i',
        app,
        '-i',
        outro,
        '-filter_complex',
        `[0:v]${norm}[a];[1:v]${norm}[b];[2:v]${norm}[c];[a][b][c]concat=n=3:v=1:a=0[v]`,
        '-map',
        '[v]',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        '18',
        '-movflags',
        '+faststart',
        out,
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    ).status === 0;
  console.log(ok ? `✓ ${out}` : `✗ ${slug}: ffmpeg failed`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
