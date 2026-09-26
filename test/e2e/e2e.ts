#!/usr/bin/env bun
// End-to-end checks: the real `claude` binary, launched through claude-any,
// against a live provider. Every assertion reads real output (files on disk,
// process exit, stdout JSON, stderr), never the model's own claim alone.
//
//   CLAUDE_ANY_HOME=<configured home> bun test/e2e/e2e.ts <provider/model>… [--deep <provider/model>…]
//
// Every model runs the tool-use scenario. `--deep` models also run auto mode,
// image-in-tool-result, subagent, session continuation, and /compact.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BIN = resolve(import.meta.dir, '../../bin/claude-any');
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 300_000);
const AUTO_MODE_NOTICE = /isn't eligible|auto mode to no longer charge/i;

interface RunResult {
  code: number;
  json: Record<string, any> | null;
  stderr: string;
}

function run(cwd: string, model: string, prompt: string, extra: string[] = []): Promise<RunResult> {
  return new Promise((done) => {
    const child = spawn(BIN, ['-p', prompt, '--model', model, '--output-format', 'json', ...extra], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      let json: Record<string, any> | null = null;
      try {
        json = JSON.parse(out);
      } catch {
        // Leave null; the scenario reports the raw output.
      }
      done({ code: code ?? 1, json, stderr: err });
    });
  });
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const inputTokens = (r: RunResult): number =>
  Object.values((r.json?.modelUsage ?? {}) as Record<string, { inputTokens: number; cacheReadInputTokens: number }>).reduce(
    (sum, u) => sum + u.inputTokens + u.cacheReadInputTokens,
    0,
  );

const summary = (r: RunResult) =>
  `exit=${r.code} error=${r.json?.is_error} turns=${r.json?.num_turns} tokens=${inputTokens(r)} result=${JSON.stringify(String(r.json?.result ?? r.stderr).slice(0, 100))}`;

function workdir(model: string, scenario: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ca-e2e-${model.replace(/\W+/g, '_')}-${scenario}-`));
  // Claude Code asks to trust a new folder only interactively; -p skips it.
  return dir;
}

async function toolUse(model: string): Promise<Check> {
  const cwd = workdir(model, 'tool');
  const r = await run(
    cwd,
    model,
    'Create calc.py that prints the product of 1234 and 5678. Run it with python3 using the Bash tool. Reply with only the printed number.',
    ['--allowedTools', 'Bash,Write,Read,Edit'],
  );
  const file = join(cwd, 'calc.py');
  const printed = existsSync(file) ? spawnSync('python3', [file], { encoding: 'utf8' }).stdout.trim() : '';
  const ok = r.code === 0 && r.json?.is_error === false && printed === '7006652' && String(r.json?.result).includes('7006652') && inputTokens(r) > 0;
  return { name: 'tool use (Write + Bash)', ok, detail: `${summary(r)} calc.py→${printed || 'missing'}` };
}

async function autoMode(model: string): Promise<Check> {
  const cwd = workdir(model, 'auto');
  const r = await run(cwd, model, 'Use the Bash tool to run: echo auto-mode-ok > marker.txt . Then reply done.', ['--permission-mode', 'auto']);
  const marker = existsSync(join(cwd, 'marker.txt')) ? readFileSync(join(cwd, 'marker.txt'), 'utf8').trim() : '';
  const notice = AUTO_MODE_NOTICE.test(r.stderr);
  const ok = r.code === 0 && marker === 'auto-mode-ok' && !notice;
  return { name: 'auto mode, no billing notice', ok, detail: `${summary(r)} marker=${marker || 'missing'} notice=${notice}` };
}

async function imageInToolResult(model: string): Promise<Check> {
  const cwd = workdir(model, 'image');
  const png = join(cwd, 'shot.png');
  spawnSync('python3', ['-c', `
from PIL import Image, ImageDraw, ImageFont
img = Image.new('RGB', (900, 300), 'white')
d = ImageDraw.Draw(img)
try:
    f = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial Bold.ttf', 140)
except Exception:
    f = ImageFont.load_default()
d.text((40, 70), 'ZEBRA 47', fill='black', font=f)
img.save(${JSON.stringify(png)})
`]);
  const r = await run(cwd, model, 'Use the Read tool on shot.png and tell me exactly the word and the number written in the image.', ['--allowedTools', 'Read']);
  const text = String(r.json?.result ?? '').toUpperCase();
  const ok = r.code === 0 && text.includes('ZEBRA') && text.includes('47');
  return { name: 'image returned by Read reaches the model', ok, detail: summary(r) };
}

async function subagent(model: string): Promise<Check> {
  const cwd = workdir(model, 'agent');
  writeFileSync(join(cwd, 'needle.txt'), 'the secret is 8841\n');
  writeFileSync(join(cwd, 'hay.txt'), 'nothing here\n');
  const r = await run(cwd, model, 'Use the Agent tool with subagent_type Explore to find which file in this directory contains the word secret and what the secret number is. Reply with the number.', ['--allowedTools', 'Agent,Read,Glob,Grep,Bash']);
  const spawned = r.json?.subagent_stats?.spawned ?? 0;
  const ok = r.code === 0 && spawned >= 1 && String(r.json?.result).includes('8841');
  return { name: 'subagent (Explore)', ok, detail: `${summary(r)} subagents=${spawned}` };
}

async function continuation(model: string): Promise<Check> {
  const cwd = workdir(model, 'resume');
  const first = await run(cwd, model, 'Remember this code word: MARIGOLD-93. Reply only with OK.');
  const second = await run(cwd, model, 'What was the code word I gave you? Reply with only the code word.', ['--continue']);
  const ok = first.code === 0 && second.code === 0 && String(second.json?.result).includes('MARIGOLD-93');
  return { name: 'session continuation (--continue)', ok, detail: `first: ${summary(first)} | second: ${summary(second)}` };
}

async function compact(model: string): Promise<Check> {
  const cwd = workdir(model, 'compact');
  const first = await run(cwd, model, 'Remember: the launch date is 2031-04-17. Reply only with OK.');
  const compacted = await run(cwd, model, '/compact', ['--continue']);
  const after = await run(cwd, model, 'What is the launch date? Reply with only the date.', ['--continue']);
  const ok = first.code === 0 && compacted.code === 0 && compacted.json?.is_error === false && after.code === 0 && String(after.json?.result).includes('2031-04-17');
  return { name: '/compact then recall', ok, detail: `compact: ${summary(compacted)} | after: ${summary(after)}` };
}

async function main() {
  const args = process.argv.slice(2);
  const deepAt = args.indexOf('--deep');
  const models = deepAt < 0 ? args : args.slice(0, deepAt);
  const deep = deepAt < 0 ? [] : args.slice(deepAt + 1);
  if (!process.env.CLAUDE_ANY_HOME) throw new Error('Set CLAUDE_ANY_HOME to a configured claude-any home');
  const all = [...new Set([...models, ...deep])];

  const jobs = all.map(async (model) => {
    const scenarios = [toolUse];
    if (deep.includes(model)) scenarios.push(autoMode, imageInToolResult, subagent, continuation, compact);
    const checks = await Promise.all(scenarios.map((s) => s(model)));
    return { model, checks };
  });

  let failed = 0;
  for (const { model, checks } of await Promise.all(jobs)) {
    console.log(`\n${model}`);
    for (const c of checks) {
      if (!c.ok) failed++;
      console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}\n      ${c.detail}`);
    }
  }
  console.log(`\n${failed ? `${failed} check(s) failed` : 'all checks passed'}`);
  process.exit(failed ? 1 : 0);
}

mkdirSync(tmpdir(), { recursive: true });
await main();
