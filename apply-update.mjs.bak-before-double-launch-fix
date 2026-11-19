// DSH 本体更新执行器（v0.5）：快照 → 服务可用性预检 → 安装 → 健康检查 → 失败自动回滚。
//
// 由 main.js 通过 `systemd-run --unit=dsh-autoupdater-apply` 启动，
// 因此不在 dsh-web.service 的 cgroup 里 —— 重启 dsh-web 不会杀掉本进程。
//
// 环境变量：
//   AUTOUPDATE_STATE_DIR     状态目录（含 pending-update.json）
//   AUTOUPDATE_SYSTEMD_UNIT  要重启的 systemd 服务名（可空）
//   AUTOUPDATE_ARGV          原启动 argv（空格分隔，systemd 不可用时的裸拉起兜底）

import { readFileSync, existsSync, rmSync, appendFileSync, mkdirSync, cpSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const stateDir = process.env.AUTOUPDATE_STATE_DIR || '';
const pendingPath = join(stateDir, 'pending-update.json');
const logPath = join(stateDir, 'apply.log');
const historyPath = join(stateDir, 'history.jsonl');

function alog(msg) {
  try {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}
function ahistory(obj) {
  try { appendFileSync(historyPath, JSON.stringify({ at: new Date().toISOString(), ...obj }) + '\n'); } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

alog(`apply-update started (pid=${process.pid}, stateDir=${stateDir})`);

if (!stateDir) { alog('AUTOUPDATE_STATE_DIR missing'); process.exit(1); }
if (!existsSync(pendingPath)) { alog('no pending-update.json'); process.exit(0); }

const instruction = JSON.parse(readFileSync(pendingPath, 'utf8'));
const unit = instruction.systemdUnit || process.env.AUTOUPDATE_SYSTEMD_UNIT || '';
const nodeBin = instruction.nodeBin || process.execPath;
const prefix = dirname(nodeBin);
const dshBin = join(prefix, 'dsh');
const npmBin = join(prefix, 'npm');
const globalRoot = `${prefix}/../lib/node_modules/@deepseek-ai/dsh`;
const profileDir = instruction.profileDir || process.env.DSH_PROFILE_DIR || '';
const port = Number(instruction.port) || 3080;
const healthSeconds = Number(instruction.healthCheckSeconds) || 90;
const autoRollback = instruction.autoRollback !== false;

alog(`target=${instruction.pkg}@${instruction.tag} from=${instruction.from} unit=${unit || 'none'} port=${port} rollback=${autoRollback}`);

// ───────── 1. 快照（回滚用）─────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const snapDir = join(stateDir, 'snapshots', stamp);
const snap = { dshVersion: null, profileFiles: [] };
try {
  mkdirSync(snapDir, { recursive: true });
  try { snap.dshVersion = JSON.parse(readFileSync(`${globalRoot}/package.json`, 'utf8')).version; } catch {}
  if (profileDir) {
    for (const f of ['package.json', 'cordis.patch.yml']) {
      const src = join(profileDir, f);
      if (existsSync(src)) {
        cpSync(src, join(snapDir, f));
        snap.profileFiles.push(f);
      }
    }
  }
  writeFileSync(join(snapDir, 'snapshot.json'), JSON.stringify(snap, null, 2));
  alog(`snapshot saved: ${snapDir} (dsh=${snap.dshVersion}, files=${snap.profileFiles.join(',') || 'none'})`);
} catch (e) {
  alog(`snapshot failed: ${e.message} — 继续但不保证可回滚`);
}

// ───────── 2. 安装（服务仍在运行，只替换磁盘）─────────
function runNpmInstall(targetSpec) {
  try {
    const r = spawnSync(npmBin, ['install', '-g', targetSpec], { encoding: 'utf8', timeout: 900000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    alog(`npm install ${targetSpec} exit=${r.status}\n${out.slice(-2500)}`);
    return r.status === 0;
  } catch (e) {
    alog(`npm install threw: ${e.message}`);
    return false;
  }
}

const installOk = runNpmInstall(`${instruction.pkg}@${instruction.tag}`);

function readDiskVersion() {
  try { return JSON.parse(readFileSync(`${globalRoot}/package.json`, 'utf8')).version; } catch { return null; }
}
const newVer = readDiskVersion();
alog(`disk version after install: ${newVer}`);

// ───────── 3. 防变砖 + 服务可用性预检（B）─────────
if (!existsSync(dshBin)) {
  alog(`FATAL: dsh binary missing at ${dshBin} — NOT restarting`);
  ahistory({ kind: 'harness-aborted', reason: 'dsh binary missing', applied: newVer });
  try { rmSync(pendingPath); } catch {}
  process.exit(1);
}

function collectRequiredServices() {
  try {
    const p = join(profileDir, 'cordis.patch.yml');
    if (!existsSync(p)) return [];
    const text = readFileSync(p, 'utf8');
    const set = new Set();
    for (const m of text.matchAll(/^[^\n#]*!!js\s+[^\n]*?ctx\.([A-Za-z_$][\w$]*)/gm)) set.add(m[1]);
    return [...set];
  } catch { return []; }
}

// 在新装版本自己的依赖树里找该服务是否仍被提供
// （只扫 dsh 包自带的 node_modules，避免全局残留的旧包造成假阳性）
function serviceExistsInInstall(name) {
  try {
    const nm = `${globalRoot}/node_modules/@deepseek-ai`;
    const r = spawnSync('grep', ['-rl', '--include=*.js', name, nm], { encoding: 'utf8' });
    return (r.stdout || '').trim() !== '';
  } catch { return true; }
}

if (profileDir && newVer && autoRollback) {
  const required = collectRequiredServices();
  if (required.length) {
    const missing = required.filter((s) => !serviceExistsInInstall(s));
    alog(`service precheck: required=${required.join(',')} missing=${missing.join(',') || 'none'}`);
    if (missing.length) {
      alog(`PRECHECK FAILED: 新版本 ${newVer} 里找不到服务 ${missing.join(',')}（profile 配置引用了它们）`);
      ahistory({ kind: 'precheck-failed', to: newVer, missing });
      if (snap.dshVersion) {
        alog(`rolling back install to ${snap.dshVersion} (service untouched)`);
        runNpmInstall(`${instruction.pkg}@${snap.dshVersion}`);
        alog(`disk version after rollback: ${readDiskVersion()}`);
      }
      try { rmSync(pendingPath); } catch {}
      process.exit(1);
    }
  }
}

if (!installOk) {
  // 安装失败：绝不重启（重启只会白白打断会话，版本也没变）
  alog(`install failed (exit != 0) — NOT restarting; disk stays at ${newVer}`);
  ahistory({ kind: 'harness-aborted', reason: 'npm install failed', applied: newVer });
  try { rmSync(pendingPath); } catch {}
  process.exit(1);
}

ahistory({ kind: 'harness-installed', from: instruction.from, to: instruction.tag, applied: newVer });

// ───────── 4. 重启 ─────────
async function restartService() {
  if (unit) {
    try {
      const r = spawn('sudo', ['-n', 'systemctl', 'restart', unit], { stdio: 'ignore' });
      const code = await new Promise((res) => {
        const t = setTimeout(() => res(-1), 120000);
        r.on('close', (c) => { clearTimeout(t); res(c); });
        r.on('error', () => { clearTimeout(t); res(-1); });
      });
      alog(`systemctl restart ${unit} exit=${code}`);
      return code === 0;
    } catch (e) { alog(`systemctl restart threw: ${e.message}`); return false; }
  }
  const argv = (process.env.AUTOUPDATE_ARGV || '').trim().split(/\s+/).filter(Boolean);
  if (argv.length >= 2 && existsSync(argv[1])) {
    try {
      const child = spawn(argv[1], argv.slice(2), { detached: true, stdio: 'ignore' });
      child.unref();
      alog(`fallback relaunch pid=${child.pid}`);
      return true;
    } catch (e) { alog(`fallback relaunch failed: ${e.message}`); }
  }
  return false;
}

// ───────── 5. 健康检查（A）─────────
async function healthCheck(seconds) {
  const deadline = Date.now() + seconds * 1000;
  let lastErr = '';
  while (Date.now() < deadline) {
    await sleep(3000);
    if (unit) {
      const r = spawnSync('systemctl', ['is-active', unit], { encoding: 'utf8' });
      const st = (r.stdout || '').trim();
      if (st !== 'active') { lastErr = `unit ${st}`; continue; }
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) });
      alog(`health: HTTP ${res.status}`);
      return { ok: true, status: res.status };
    } catch (e) {
      lastErr = e?.cause?.code || e?.message || 'fetch failed';
    }
  }
  alog(`health check FAILED after ${seconds}s (last: ${lastErr})`);
  return { ok: false, reason: lastErr };
}

const restarted = await restartService();
if (!restarted) {
  alog('restart failed; leaving service as-is');
  ahistory({ kind: 'harness-restart-failed', to: newVer });
  try { rmSync(pendingPath); } catch {}
  process.exit(1);
}

const health = await healthCheck(healthSeconds);

// ───────── 6. 失败回滚（A）─────────
if (!health.ok && autoRollback && snap.dshVersion) {
  alog(`rollback: 回滚到 ${snap.dshVersion} 并恢复 profile 文件`);
  ahistory({ kind: 'harness-rollback-start', from: newVer, to: snap.dshVersion, reason: health.reason });
  runNpmInstall(`${instruction.pkg}@${snap.dshVersion}`);
  for (const f of snap.profileFiles) {
    try { cpSync(join(snapDir, f), join(profileDir, f)); alog(`restored ${f}`); } catch (e) { alog(`restore ${f} failed: ${e.message}`); }
  }
  const verAfter = readDiskVersion();
  alog(`disk version after rollback: ${verAfter}`);
  await restartService();
  const h2 = await healthCheck(Math.min(healthSeconds, 60));
  alog(`post-rollback health: ${h2.ok ? 'OK' : 'STILL BAD (' + h2.reason + ')'}`);
  ahistory({
    kind: 'harness-rolled-back',
    to: verAfter, recovered: h2.ok, reason: health.reason,
    snapshot: snapDir,
  });
  try { rmSync(pendingPath); } catch {}
  process.exit(h2.ok ? 2 : 3); // 2 = 已回滚并恢复
}

ahistory({ kind: 'harness-applied', from: instruction.from, to: instruction.tag, applied: newVer, healthy: health.ok });
try { rmSync(pendingPath); } catch {}
alog(`done (installed=${newVer}, health=${health.ok})`);
process.exit(health.ok ? 0 : 1);
