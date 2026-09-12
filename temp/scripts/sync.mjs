#!/usr/bin/env node
// Copy pipeline output from backend/experiments/<name>/ into public/data/<name>/ so the static
// site can fetch it, and write public/data/index.json listing what is there.
//
// Usage:
//   node scripts/sync.mjs              # every experiment under backend/experiments/
//   node scripts/sync.mjs experiment1  # just that one (others already in public/data/ are kept)
//   EXPERIMENTS_DIR=/elsewhere node scripts/sync.mjs
//
// Copied per experiment: inventory.json, events.json, expire.json, recipes.json and, for each
// runs/<stamp>/, events.json, inventory.json, run.log. Nothing else (no videos, no .venv).
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPERIMENTS = resolve(process.env.EXPERIMENTS_DIR || join(FRONTEND, '..', 'backend', 'experiments'));
const OUT = join(FRONTEND, 'public', 'data');
const ROOT_FILES = ['inventory.json', 'events.json', 'expire.json', 'recipes.json'];
const RUN_FILES = ['events.json', 'inventory.json', 'run.log'];

const log = (...args) => console.error('sync:', ...args);

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function isDir(path) {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

// Real experiment folders only; `latest` is a symlink the pipeline maintains.
function listExperiments(dir) {
  return readdirSync(dir).filter(name => !name.startsWith('.') && isDir(join(dir, name))).sort();
}

// Resolve a requested name: a symlink like `latest` maps to the folder it points at.
function resolveName(name) {
  const path = join(EXPERIMENTS, name);
  try {
    if (lstatSync(path).isSymbolicLink()) return basename(readlinkSync(path));
  } catch { /* fall through */ }
  return name;
}

function syncOne(name) {
  const src = join(EXPERIMENTS, name);
  const dst = join(OUT, name);
  if (!existsSync(join(src, 'inventory.json'))) {
    log(`skipping ${name}: no inventory.json in ${src}`);
    return false;
  }
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  const copied = [];
  for (const file of ROOT_FILES) {
    if (existsSync(join(src, file))) { cpSync(join(src, file), join(dst, file)); copied.push(file); }
    else log(`warning: ${name} has no ${file}`);
  }
  let runs = 0;
  const runsDir = join(src, 'runs');
  if (isDir(runsDir)) {
    for (const run of readdirSync(runsDir).filter(r => isDir(join(runsDir, r)))) {
      mkdirSync(join(dst, 'runs', run), { recursive: true });
      for (const file of RUN_FILES) {
        if (existsSync(join(runsDir, run, file))) cpSync(join(runsDir, run, file), join(dst, 'runs', run, file));
      }
      runs += 1;
    }
  }
  log(`${name}: ${copied.length} file(s), ${runs} run(s) -> ${dst}`);
  return true;
}

// index.json describes whatever is in public/data/ right now, not just what this call copied.
function writeIndex(latestHint) {
  mkdirSync(OUT, { recursive: true });
  const experiments = readdirSync(OUT)
    .filter(name => isDir(join(OUT, name)) && existsSync(join(OUT, name, 'inventory.json')))
    .sort()
    .map(name => {
      const inventory = readJson(join(OUT, name, 'inventory.json')) || {};
      const runsDir = join(OUT, name, 'runs');
      const runs = isDir(runsDir) ? readdirSync(runsDir).filter(r => isDir(join(runsDir, r))).sort() : [];
      return {
        name,
        updated_at: inventory.updated_at || null,
        items: Array.isArray(inventory.in_fridge) ? inventory.in_fridge.length : 0,
        runs,
        files: ROOT_FILES.filter(file => existsSync(join(OUT, name, file))),
      };
    });
  const names = experiments.map(e => e.name);
  let latest = names.includes(latestHint) ? latestHint : null;
  if (!latest && experiments.length) {
    latest = [...experiments].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))[0].name;
  }
  const index = { synced_at: new Date().toISOString(), source: EXPERIMENTS, latest, experiments };
  writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  log(`index.json: ${experiments.length} experiment(s), latest = ${latest ?? 'none'}`);
  return index;
}

function main(argv) {
  if (!isDir(EXPERIMENTS)) {
    log(`no experiments folder at ${EXPERIMENTS}; leaving public/data/ as is`);
    if (!existsSync(join(OUT, 'index.json'))) log('warning: public/data/index.json is missing, the site will show no data');
    return 0;
  }
  const requested = argv.length ? argv.map(resolveName) : listExperiments(EXPERIMENTS);
  const missing = requested.filter(name => !isDir(join(EXPERIMENTS, name)));
  if (missing.length) {
    log(`no such experiment(s): ${missing.join(', ')} (looked in ${EXPERIMENTS})`);
    return 2;
  }
  const done = requested.filter(syncOne);
  const latestHint = existsSync(join(EXPERIMENTS, 'latest')) ? resolveName('latest') : null;
  const index = writeIndex(latestHint);
  if (!index.experiments.length) log('warning: nothing synced, the site will show no data');
  return done.length === requested.length ? 0 : 1;
}

process.exit(main(process.argv.slice(2)));
