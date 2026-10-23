import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { basename, delimiter, dirname, join } from 'node:path';

/**
 * dsh-autoupdater — 定时检查 DSH 本体与已装 bundle 插件的更新。
 * 零第三方依赖。
 *
 * 配置分两层：
 *  - 初始值：cordis.patch.yml 的 config（loader 注入）
 *  - 运行值：$DSH_HOME/autoupdater/config.json（Web 面板写入，保存即生效，无需重启）
 * 安全门槛字段（idleSeconds/idleTimeoutMinutes/graceMinutes）由面板提交但服务端强制 clamp，
 * 不提供绕过空闲判定的选项。
 *
 * 安全门槛（缺一不可）：
 *  1. 所有 Agent 状态为 idle
 *  2. 连续 idleSeconds 秒无任何会话活动
 *  3. DSH 本体重启额外要求：graceMinutes 宽限期内 activity 时间戳无推进
 */

const DEFAULTS = Object.freeze({
  scheduleMode: 'daily',        // daily | everyHours | everyDays | everyMinutes
  dailyTime: '04:30',           // daily / everyDays 锚定时刻
  everyHours: 6,                // 每 N 小时（整点对齐）
  everyDays: 1,                 // 每 N 天（锚定 dailyTime）
  everyMinutes: 60,             // 每 N 分钟（从启动/保存时刻起算）
  idleTimeoutMinutes: 120,
  idleSeconds: 300,
  verbose: true,
  harnessMode: 'notify',        // off | notify | auto（默认 notify：陌生人安装保守起步）
  graceMinutes: 30,
  autoRollback: true,           // 升级后健康检查失败 → 自动回滚到旧版本并恢复配置
  healthCheckSeconds: 90,       // 重启后等待服务健康的秒数
  distTag: 'latest',            // 插件查询用的 npm dist-tag
  harnessDistTag: '',           // DSH 本体查询用的 dist-tag；空 = 跟 distTag（可设 next 追预发布）
  systemdUnit: '',              // 重启用的 systemd 服务名；空 = 自动探测
  pluginMode: 'regexmode-ignore', // regexmode-ignore | auto-all | notify-all | off | whitelist-auto
  whitelist: [],
});

const PLUGIN_MODES = new Set(['regexmode-ignore', 'auto-all', 'notify-all', 'off', 'whitelist-auto']);
const HARNESS_MODES = new Set(['off', 'notify', 'auto']);
const SCHEDULE_MODES = new Set(['daily', 'everyHours', 'everyDays', 'everyMinutes']);

// ─────────────────────────── 小工具 ───────────────────────────

const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function clampInt(v, min, max, dflt) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/** 规范化任意来源的配置对象，返回安全可用的完整配置。 */
function normalizeConfig(raw = {}) {
  const c = { ...DEFAULTS, ...(raw ?? {}) };
  c.scheduleMode = SCHEDULE_MODES.has(c.scheduleMode) ? c.scheduleMode : DEFAULTS.scheduleMode;
  c.harnessMode = HARNESS_MODES.has(c.harnessMode) ? c.harnessMode : DEFAULTS.harnessMode;
  c.pluginMode = PLUGIN_MODES.has(c.pluginMode) ? c.pluginMode : DEFAULTS.pluginMode;
  if (typeof c.dailyTime !== 'string' || !HHMM_RE.test(c.dailyTime)) c.dailyTime = DEFAULTS.dailyTime;
  c.everyHours = clampInt(c.everyHours, 1, 168, DEFAULTS.everyHours);
  c.everyDays = clampInt(c.everyDays, 1, 365, DEFAULTS.everyDays);
  c.everyMinutes = clampInt(c.everyMinutes, 1, 10080, DEFAULTS.everyMinutes);
  c.idleSeconds = clampInt(c.idleSeconds, 30, 3600, DEFAULTS.idleSeconds);
  c.idleTimeoutMinutes = clampInt(c.idleTimeoutMinutes, 5, 720, DEFAULTS.idleTimeoutMinutes);
  c.graceMinutes = clampInt(c.graceMinutes, 1, 720, DEFAULTS.graceMinutes);
  c.autoRollback = c.autoRollback !== false;
  c.healthCheckSeconds = clampInt(c.healthCheckSeconds, 30, 600, DEFAULTS.healthCheckSeconds);
  c.whitelist = Array.isArray(c.whitelist)
    ? [...new Set(c.whitelist.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim()))]
    : [];
  c.verbose = c.verbose !== false;
  // dist-tag 规范化：harnessDistTag 留空则跟随 distTag
  if (typeof c.distTag !== 'string' || !c.distTag.trim()) c.distTag = DEFAULTS.distTag;
  if (typeof c.harnessDistTag !== 'string') c.harnessDistTag = '';
  c.harnessDistTag = c.harnessDistTag.trim() || c.distTag;
  return c;
}

/** 下次调度触发的时间戳（ms）。 */
function nextRunAt(c, fromMs = Date.now()) {
  const [h, m] = String(c.dailyTime).split(':').map(Number);
  if (c.scheduleMode === 'daily') {
    const target = new Date(fromMs);
    target.setHours(h, m, 0, 0);
    if (target.getTime() <= fromMs) target.setDate(target.getDate() + 1);
    return target.getTime();
  }
  if (c.scheduleMode === 'everyHours') {
    // 整点对齐：每 everyHours 小时的边界整点触发
    const interval = c.everyHours * 3600_000;
    const dayStart = new Date(fromMs); dayStart.setHours(0, 0, 0, 0);
    for (let i = 1; i <= 24; i++) {
      const t = dayStart.getTime() + i * interval;
      if (t > fromMs) return t;
    }
    return dayStart.getTime() + 24 * 3600_000;
  }
  if (c.scheduleMode === 'everyDays') {
    const target = new Date(fromMs);
    target.setHours(h, m, 0, 0);
    if (target.getTime() <= fromMs) target.setDate(target.getDate() + c.everyDays);
    return target.getTime();
  }
  // everyMinutes：从现在起算
  return fromMs + c.everyMinutes * 60_000;
}

function semverGt(a, b) {
  if (!a || !b) return false;
  const pa = String(a).replace(/^v/, '').split(/[.+-]/).map(Number);
  const pb = String(b).replace(/^v/, '').split(/[.+-]/).map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

function log(...args) {
  console.log('[dsh-autoupdater]', ...args);
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

/** 运行子进程并收集 stdout+stderr；超时或无法启动 → code -1。 */
function spawnCapture(command, args, { env = process.env, timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let child;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve({ code, output });
    };
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch (e) {
      output += String(e?.message ?? e);
      finish(-1);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      output += `\n[dsh-autoupdater] timeout after ${timeoutMs}ms`;
      finish(-1);
    }, timeoutMs);
    child.stdout?.on('data', (d) => { output += d; });
    child.stderr?.on('data', (d) => { output += d; });
    child.on('close', (c) => { clearTimeout(timer); finish(c); });
    child.on('error', (e) => { clearTimeout(timer); output += `\n${e?.message ?? e}`; finish(-1); });
  });
}

/** 从命令输出里挑一条最能说明失败原因的行（优先 ERROR 类关键词）。 */
function lastMeaningfulLine(text, limit = 220) {
  const lines = String(text ?? '')
    .split('\n')
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .filter(Boolean);
  if (lines.length === 0) return '';
  const errorLike = [...lines].reverse().find((line) => /ERR_|ERROR|\berror\b|fatal:|Cannot|failed|not found|E[A-Z]{4,}/i.test(line));
  return (errorLike ?? lines[lines.length - 1]).slice(0, limit);
}

// ─────────────────────────── 主插件 ───────────────────────────

export const inject = ['agents', 'pluginManager', 'webServer'];

export function apply(ctx, rawConfig = {}) {
  const home = process.env.DSH_HOME || `${process.env.HOME}/.dsh`;
  const stateDir = `${home}/autoupdater`;
  const statePath = `${stateDir}/status.json`;
  const historyPath = `${stateDir}/history.jsonl`;
  const pendingPath = `${stateDir}/pending-update.json`;
  const hotConfigPath = `${stateDir}/config.json`;

  let state = { lastRun: null, lastNotice: null, updates: [], lastError: null };
  readJson(statePath).then((s) => { if (s) state = { ...state, ...s }; }).catch(() => {});

  // 初始配置 = YAML 注入值；运行时覆盖来自 config.json（每次调度/检查前重读）
  let config = normalizeConfig(rawConfig);

  async function reloadHotConfig() {
    const hot = await readJson(hotConfigPath);
    if (hot) config = normalizeConfig({ ...rawConfig, ...hot });
  }

  // ── profile 目录探测（磁盘版本回读用）──
  // DSH_PROFILE_DIR 优先；否则在 $DSH_HOME/profiles 下找含 node_modules 的目录，
  // 多个时取 node_modules 最近修改的。找不到 = 磁盘回读退化为仅信安装结果。
  let profileDir = process.env.DSH_PROFILE_DIR || null;
  try {
    const base = `${home}/profiles`;
    const candidates = readdirSync(base)
      .map((name) => `${base}/${name}`)
      .filter((dir) => existsSync(`${dir}/node_modules`));
    if (candidates.length === 1) {
      profileDir = candidates[0];
    } else if (candidates.length > 1) {
      profileDir = candidates
        .map((dir) => ({ dir, m: statSync(`${dir}/node_modules`).mtimeMs }))
        .sort((a, b) => b.m - a.m)[0].dir;
    }
    if (profileDir && config.verbose) log('profileDir detected:', profileDir);
  } catch {}

  /** 是否运行在 Electron 桌面 App 的进程里（macOS/Windows 安装包）。 */
  const isDesktopApp = () => typeof process.versions?.electron === 'string';

  /**
   * 找一条能真正写 profile 的 `dsh plugin` 入口。
   *
   * 桌面 App 有两条特殊约束，也是“更新永远 failed”的根因：
   *  1. process.execPath 是 Electron 可执行文件，同目录没有 `dsh`（Linux npm 全局安装的布局）；
   *  2. 即使找到普通 `dsh`，它也会以
   *     `profile "desktop" is managed exclusively by the Electron application` 拒绝 desktop 保留 profile。
   * 安装包自带 dsh-desktop-host/lib/cli.js，它以 manageDesktopProfile=true 调 runCli，
   * 是桌面版唯一官方允许写 desktop profile 的入口。
   */
  function resolvePluginCli() {
    if (isDesktopApp() && process.resourcesPath) {
      const desktopCli = join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules',
        '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
      if (existsSync(desktopCli)) {
        return {
          command: process.execPath,
          prefixArgs: [desktopCli],
          env: { ELECTRON_RUN_AS_NODE: '1' },
          label: 'desktop-cli',
        };
      }
      log('desktop CLI not found at', desktopCli);
    }
    // 普通 npm 全局安装：dsh 与 node 同目录（Linux 常见布局）
    const sibling = join(dirname(process.execPath), process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
    if (existsSync(sibling)) return { command: sibling, prefixArgs: [], env: {}, label: 'sibling-cli' };
    // 最后退回 PATH（macOS 上 npm 全局安装常见于 ~/.local/bin，而非 node 同目录）
    const binName = process.platform === 'win32' ? 'dsh.cmd' : 'dsh';
    for (const dir of String(process.env.PATH ?? '').split(delimiter)) {
      if (!dir) continue;
      const candidate = join(dir, binName);
      if (existsSync(candidate)) return { command: candidate, prefixArgs: [], env: {}, label: 'path-cli' };
    }
    return null;
  }

  // ---- 活动追踪 ----
  let lastActivity = nowSec();
  const bump = () => { lastActivity = nowSec(); };

  const disposers = [];
  try { disposers.push(ctx.on('api-session/activity', bump)); } catch {}
  try { disposers.push(ctx.on('agent/inbox/inserted', bump)); } catch {}
  try { disposers.push(ctx.on('session/created', bump)); } catch {}
  try {
    disposers.push(ctx.on('agent/status', ({ status }) => { if (status === 'running') bump(); }));
  } catch {}

  // 借鉴 dsh-self-upgrade 的判定（实测比 agent.status 可靠）：
  // 会话日志 2 分钟内无任何写入 = 无进行中的工作。agent.status 存在 turn 结束
  // 后仍停留 'running' 的情况（本机实测），会永久阻塞空闲判定，故弃用。
  const sessionsDir = `${home}/sessions`;
  let sessionsBusyCache = { at: 0, busy: true };
  const anyAgentRunning = () => {
    const now = Date.now();
    if (now - sessionsBusyCache.at < 8000) return sessionsBusyCache.busy; // 8s 缓存
    try {
      // mtime 探测：-newermt 用固定秒窗避免 -mmin 的分钟取整误差
      const cutoff = new Date(Date.now() - 120_000).toISOString();
      const out = execSync(
        `find ${JSON.stringify(sessionsDir)} -type f -newermt ${JSON.stringify(cutoff)} 2>/dev/null | head -1`,
        { timeout: 8000 },
      ).toString().trim();
      sessionsBusyCache = { at: now, busy: out !== '' };
    } catch { sessionsBusyCache = { at: now, busy: true }; } // 探测失败保守当忙
    return sessionsBusyCache.busy;
  };

  const idleFor = () => nowSec() - lastActivity;
  const isIdle = () => !anyAgentRunning() && idleFor() >= config.idleSeconds;

  /** 等到空闲；true=达成，false=超时。双重采样防瞬时空档误判。 */
  async function waitIdle(maxWaitSec) {
    const deadline = nowSec() + maxWaitSec;
    while (nowSec() < deadline) {
      if (isIdle()) {
        await sleep(15000);
        if (isIdle()) return true;
        continue;
      }
      await sleep(30000);
    }
    return isIdle();
  }

  async function saveState() {
    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(statePath, JSON.stringify(state, null, 2));
    } catch (e) { log('saveState failed:', e?.message); }
  }
  async function appendHistory(entry) {
    try {
      await mkdir(stateDir, { recursive: true });
      await appendFile(historyPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
      // 日志轮转：超过 500 条时保留最近 300 条（防止多年运行无限增长）
      const raw = await readFile(historyPath, 'utf8').catch(() => '');
      const lines = raw.split('\n').filter(Boolean);
      if (lines.length > 500) {
        await writeFile(historyPath, lines.slice(-300).join('\n') + '\n');
      }
    } catch {}
  }

  async function notify(title, desp) {
    log('NOTIFY:', title, '—', desp);
    state.lastNotice = { at: new Date().toISOString(), title, desp };
    await saveState();
  }

  // ---- npm 查询 ----
  // 根因（本机实测）：Host 进程内 getaddrinfo 返回的 CDN IP 停留在故障窗口的坏记录
  // （所有 registry 域名都连向同一个不可达 IP，300ms 即 ETIMEDOUT），而新进程/shell
  // 解析正常。对策：fetch 走自定义 connect.lookup —— 用 dns.resolve4 直连 DNS 服务器
  // 解析（绕过 getaddrinfo 的 nscd/systemd-resolved 进程级缓存），且强制 IPv4。
  import('undici').then((u) => { globalThis.__undiciAgentCtor = u.Agent; }).catch(() => {});
  import('node:dns').then((m) => { globalThis.__dnsMod = m; }).catch(() => {});
  function freshLookup(hostname, opts, cb) {
    const dnsMod = globalThis.__dnsMod;
    if (!dnsMod) { // dns 模块未就绪：退回系统 lookup
      import('node:dns').then((m) => m.lookup(hostname, opts, cb)).catch(() => cb(new Error('dns not ready')));
      return;
    }
    dnsMod.resolve4(hostname, (err, addresses) => {
      if (err || !addresses?.length) {
        // resolve4 失败（如 DNS 服务器只给 AAAA）：退回系统 lookup
        // undici/net 以 {all:true} 调用 lookup 时回调需返回数组
        return dnsMod.lookup(hostname, { ...opts, all: false, }, (e2, a2, f2) => {
          if (e2) return cb(e2);
          cb(null, [{ address: a2, family: f2 }]);
        });
      }
      cb(null, opts?.all ? [{ address: addresses[0], family: 4 }] : addresses[0], 4);
    });
  }
  // 查询源：npmmirror 为主（国内镜像，与官方数据同步，链路 0.3s），
  // registry.npmjs.org（Cloudflare 海外）在国内链路劣化时会持续 CONNECT_TIMEOUT。
  // 主源失败自动退回官方源。
  const REGISTRIES = ['https://registry.npmmirror.com', 'https://registry.npmjs.org'];
  async function npmLatestVersion(pkg, tag = null) {
    const distTag = tag ?? config.distTag;
    for (const base of REGISTRIES) {
      const t0 = Date.now();
      try {
        const fetchOpts = {
          signal: AbortSignal.timeout(20000),
          headers: { accept: 'application/json' },
        };
        // 自定义 lookup = 每次直连 DNS 服务器解析，绕过进程级坏缓存 + 强制 IPv4
        if (globalThis.__undiciAgentCtor && globalThis.__dnsMod) {
          fetchOpts.dispatcher = new globalThis.__undiciAgentCtor({
            connect: { timeout: 15000, lookup: freshLookup },
            bodyTimeout: 20000,
            headersTimeout: 20000,
          });
        }
        const res = await fetch(`${base}/${encodeURIComponent(pkg)}`, fetchOpts);
        if (!res.ok) throw new Error(`${base} ${res.status}`);
        const data = await res.json();
        const v = data?.['dist-tags']?.[distTag];
        if (config.verbose) log(`npm ${pkg}@${distTag}: ${Date.now() - t0}ms → ${v ?? 'null'} (${new URL(base).host})`);
        // 标签不存在（如插件没有 next 标签）→ 该源视为无答案，继续试下一源
        if (v == null) throw new Error(`dist-tag "${distTag}" absent`);
        return v;
      } catch (e) {
        const cause = e?.cause?.code || e?.cause?.message || e?.message;
        log(`npm ${pkg} via ${new URL(base).host} FAILED after ${Date.now() - t0}ms: ${e.message} (cause: ${cause})`);
        // 主源失败 → 退回下一源；全部失败 → 包装抛出
      }
    }
    const wrapped = new Error(`npm ${pkg} failed: all registries failed`);
    throw wrapped;
  }

  /**
   * 用 CLI 换插件版本：`dsh plugin --profile <p> add <pkg>@<ver>`（已装包替换装）。
   * 返回 { ok, code, output, reason }，ok 仅表示命令成功退出。
   */
  async function runPluginCliAdd(pkg, version) {
    const cli = resolvePluginCli();
    if (!cli) {
      const reason = '找不到可用的 dsh CLI（桌面 App 自带的 dsh-desktop-host 与 PATH 上的 dsh 都不可用）';
      log('CLI add:', reason);
      return { ok: false, code: -1, output: '', reason };
    }
    const profileName = profileDir ? basename(profileDir) : (process.env.DSH_PROFILE || 'web');
    // pnpm 自身不会在 registry 之间回退。国内链路 registry.npmjs.org 实测会连续
    // CONNECT_TIMEOUT（一次 130 个包安装用了 3 分 14 秒），而版本查询用的 npmmirror
    // 同一版本有同步副本、1~3 秒装完。先问 npmmirror，失败再退回 pnpm 默认源。
    const attempts = [REGISTRIES[0], null];
    let last = { ok: false, code: -1, output: '', reason: 'CLI 未执行' };
    for (const registry of attempts) {
      const args = [...cli.prefixArgs, 'plugin', '--profile', profileName, 'add', `${pkg}@${version}`];
      if (registry) args.push(`--registry=${registry}`);
      const run = await spawnCapture(cli.command, args, {
        env: { ...process.env, ...cli.env },
        timeoutMs: registry ? 240000 : 300000,
      });
      const output = run.output.trim();
      const host = registry ? new URL(registry).host : 'default registry';
      log(`CLI add ${pkg}@${version} [${cli.label}, ${host}] exit=${run.code}${output ? ` | ${output.slice(-300).replace(/\n/g, ' ')}` : ''}`);
      if (run.code === 0) return { ok: true, code: 0, output };
      last = {
        ok: false,
        code: run.code,
        output,
        reason: lastMeaningfulLine(output) || (run.code === -1 ? 'CLI 启动失败或超时' : `CLI 退出码 ${run.code}`),
      };
      // 启动失败/超时：换 registry 也不会更好，直接收手
      if (run.code === -1) break;
    }
    return last;
  }

  /** 从当前进程 argv 里解析 --port（健康检查用） */
  function currentPort() {
    const argv = currentArgv() ?? [];
    const i = argv.indexOf('--port');
    const p = i >= 0 ? Number(argv[i + 1]) : NaN;
    return Number.isFinite(p) ? p : 3080;
  }

  function harnessPkgPath() {
    const nodeDir = process.execPath.replace(/\/bin\/node$/, '');
    return `${nodeDir}/lib/node_modules/@deepseek-ai/dsh/package.json`;
  }

  function currentArgv() {
    try {
      return readFileSync('/proc/self/cmdline', 'utf8').split('\0').filter(Boolean);
    } catch {
      // macOS / Windows 没有 /proc。至少返回数组，避免调用方对 null 调 .join()。
      return process.argv.slice(1);
    }
  }

  // ---- DSH 本体 ----
  async function stageHarnessUpdate(latest, cur) {
    const instruction = {
      action: 'apply-harness-update',
      pkg: '@deepseek-ai/dsh',
      tag: config.harnessDistTag,
      from: cur,
      to: latest,
      nodeBin: process.execPath,
      argv: currentArgv(),
      // 重启方式：systemdUnit 有值走 systemctl restart；否则按 argv 自行拉起
      systemdUnit: config.systemdUnit || detectSystemdUnit(),
      profileDir,
      autoRollback: config.autoRollback,
      healthCheckSeconds: config.healthCheckSeconds,
      port: currentPort(),
      stagedAt: new Date().toISOString(),
    };
    await mkdir(stateDir, { recursive: true });
    await writeFile(pendingPath, JSON.stringify(instruction, null, 2));
    log('harness update staged →', latest);
  }

  /** 自动探测管理本进程的 systemd 服务名（无则返回空 = 裸进程模式） */
  function detectSystemdUnit() {
    try {
      const cgroup = readFileSync('/proc/self/cgroup', 'utf8');
      const m = cgroup.match(/\/system\.slice\/([a-z0-9@._-]+\.service)/i);
      if (m) return m[1];
    } catch {}
    return '';
  }

  /** 直接执行 systemd 重启（插件更新场景：无需 npm install，只激活磁盘上的新版本）。
   *  在主进程内同步执行；重启成功 = 本进程被杀，执行不到后续代码。 */
  async function restartViaSystemd(unit) {
    const { spawn } = await import('node:child_process');
    const r = spawn('sudo', ['-n', 'systemctl', 'restart', unit], { detached: true, stdio: 'ignore' });
    // 关键认知：restart 会先停止本服务 = 本进程被 SIGTERM，sudo 的 close 事件永远到不了，
    // 不能等 close 判定成败。发出命令即可；进程随 restart 死亡 = 成功路径。
    // 只有 sudo 本身失败（error 事件）或 10s 后进程还活着，才说明重启未发生。
    r.on('error', (e) => log(`systemctl restart spawn error: ${e.message}`));
    log(`systemctl restart ${unit} issued — process will die with the restart`);
    await new Promise((res) => {
      const t = setTimeout(() => res('still-alive'), 10000);
      process.once('exit', () => res('exited'));
    });
    return 'issued';
  }

  /**
   * 应用本体验证/重启。
   *
   * 关键设计（2026-10-18 事故后重构）：
   * - dsh-web.service 的 KillMode=control-group 会在停止服务时杀掉同 cgroup 的所有进程，
   *   所以"主进程退出后由 detach 子进程继续 npm install"在 systemd 下必然中断。
   * - 改为：更新脚本挂到独立瞬时单元（systemd-run），脱离 dsh-web 的 cgroup；
   *   并且 npm install -g 在服务【运行中】执行（只替换磁盘文件，不影响运行中进程），
   *   装好并校验通过后再重启服务。任何一步失败，服务都不受影响。
   */
  async function applyHarnessUpdateNow() {
    const pendingExists = existsSync(pendingPath);
    const unit = config.systemdUnit || detectSystemdUnit();

    // 桌面 App：DSH 本体由 electron-updater 负责，npm -g 不能也不该覆盖 .app 内的运行时；
    // 插件更新也不能从进程内安全 relaunch（会连带杀掉正在跑的会话）。统一标记“待重启”。
    if (isDesktopApp()) {
      log('desktop build: in-process restart/apply unsupported — restart required');
      await appendHistory({ kind: 'restart-required', reason: 'desktop-app', pending: pendingExists });
      return;
    }

    // 路径 A：仅插件更新（无 pending 文件）→ 无需 npm install，直接重启激活新插件
    if (!pendingExists) {
      log('no pending harness update — plugin-only restart');
      await appendHistory({ kind: 'plugin-only-restart', unit });
      if (unit) {
        await restartViaSystemd(unit);
        log('restart command returned — process still alive, keeping service as-is');
        return;
      }
      // 无 systemd 时旧代码会落到路径 B，但 apply-update.mjs 在没有 pending 文件时直接退出，
      // 根本不会重启（macOS 上还会因为 currentArgv() 为 null 抛错）。这里明确改为“待重启”。
      log('no systemd unit — cannot restart in place; restart required');
      await appendHistory({ kind: 'restart-required', reason: 'no-systemd' });
      return;
    }

    // 路径 B：本体更新 → 通过独立瞬时单元运行更新脚本（脱离 dsh-web cgroup）
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const self = join(dirname(fileURLToPath(import.meta.url)), 'apply-update.mjs');
    const envPairs = [
      ['AUTOUPDATE_STATE_DIR', stateDir],
      ['AUTOUPDATE_SYSTEMD_UNIT', unit],
      ['AUTOUPDATE_ARGV', currentArgv().join(' ')],
    ];

    let launched = false;
    if (unit) {
      try {
        const svcUser = process.env.USER || process.env.LOGNAME || 'ban';
        const args = ['-n', 'systemd-run', '--unit=dsh-autoupdater-apply', '--collect',
          '--property=Type=oneshot', '--property=StandardOutput=journal',
          '--property=StandardError=journal',
          `--uid=${svcUser}`, `--gid=${svcUser}`, // 必须与运行 dsh 的用户一致（npm -g 权限）
        ];
        for (const [k, v] of envPairs) args.push(`--setenv=${k}=${v}`);
        args.push(process.execPath, self);
        const r = spawn('sudo', args, { detached: true, stdio: 'ignore' });
        const code = await new Promise((res) => {
          const t = setTimeout(() => res(-1), 20000);
          r.on('close', (c) => { clearTimeout(t); res(c); });
          r.on('error', () => { clearTimeout(t); res(-1); });
        });
        log(`systemd-run apply unit launched (exit=${code})`);
        launched = code === 0;
        if (!launched) {
          log('systemd-run failed; falling back to detached child (may be killed by cgroup)');
        }
      } catch (e) {
        log(`systemd-run threw: ${e.message}`);
      }
    }

    if (!launched) {
      const child = spawn(process.execPath, [self], {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          AUTOUPDATE_STATE_DIR: stateDir,
          AUTOUPDATE_SYSTEMD_UNIT: unit,
          AUTOUPDATE_ARGV: currentArgv().join(' '),
        },
      });
      child.unref();
      log('detached apply child spawned (fallback path)');
    }

    await appendHistory({ kind: 'harness-apply-launched', to: harnessNotice?.version, via: launched ? 'systemd-run' : 'detached' });
    // 不再主动退出：更新脚本会自己完成 npm install → 校验 → 重启服务。
    // 服务活着期间用户仍可正常使用（只是稍后会被重启打断，这是升级的必要代价）。
  }

  async function checkHarness(report) {
    if (config.harnessMode === 'off') return;
    if (isDesktopApp()) {
      // 桌面版的 DSH 本体是 .app 内的运行时，由 App 自己的 electron-updater 升级；
      // 用 npm -g 覆盖既找不到安装路径，也会破坏签名/回滚。这里直接不查本体。
      if (config.verbose) log('desktop build: DSH core updates are owned by the app updater — skip harness check');
      return;
    }
    if (existsSync(pendingPath)) {
      if (config.verbose) log('pending update already staged, skip harness check');
      return;
    }
    const dshPkg = await readJson(harnessPkgPath());
    const cur = dshPkg?.version;
    if (!cur) { log('cannot resolve @deepseek-ai/dsh version at', harnessPkgPath()); return; }
    const latest = await npmLatestVersion('@deepseek-ai/dsh', config.harnessDistTag);
    if (!latest) return;
    if (!semverGt(latest, cur)) {
      if (config.verbose) log(`harness up to date (${cur})`);
      return;
    }
    // ── 预检（B）：patch 里的 !!js ctx.<service> 引用是跨版本升级最易失效的部分
    // （2026-10-18：0.2.1 移除了 webRuntime，用户的 connection 行引用它 → 启动失败）
    const risks = scanPatchRisks();
    if (risks.length) {
      report.push(`  ⚠ 预检：配置里有 ${risks.length} 处运行时表达式引用（跨版本可能失效）：${risks.join(', ')}`);
      await appendHistory({ kind: 'precheck-risks', risks });
      log(`precheck risks: ${risks.join(', ')}`);
    }

    report.push(`DSH 本体 ${cur} → ${latest} (staged)`);
    await stageHarnessUpdate(latest, cur);
    if (config.harnessMode === 'auto') {
      harnessNotice = { from: nowSec(), version: latest };
      await notify(
        `DSH 将自动更新到 ${latest}`,
        `${config.graceMinutes} 分钟后无人使用即自动重启。想推迟：现在打开 DSH 发条消息即可。`
      );
    } else {
      await notify(`DSH 有新版本 ${latest}`, '已暂存更新，空闲时段重启 dsh web 生效。');
    }
  }

  /** 扫描 profile 的 cordis.patch.yml，列出 !!js ctx.<service> 这类跨版本易失效的引用 */
  function scanPatchRisks() {
    try {
      const patchPath = `${profileDir || `${home}/profiles/web`}/cordis.patch.yml`;
      if (!existsSync(patchPath)) return [];
      const text = readFileSync(patchPath, 'utf8');
      const found = new Set();
      for (const m of text.matchAll(/^[^\n#]*!!js\s+[^\n]*?ctx\.([A-Za-z_$][\w$]*)/gm)) found.add(m[1]);
      return [...found];
    } catch { return []; }
  }

  // ---- 插件 ----
  function decide(name) {
    if (config.pluginMode === 'off') return 'skip';
    if (config.pluginMode === 'notify-all') return 'notify';
    if (config.pluginMode === 'auto-all') return 'auto';
    const inWl = config.whitelist.includes(name);
    if (config.pluginMode === 'regexmode-ignore') return inWl ? 'notify' : 'auto';
    if (config.pluginMode === 'whitelist-auto') return inWl ? 'auto' : 'notify';
    return 'notify';
  }

  // 重复更新抑制：24h 内同一 name@to 不重装（installBundle 返回 restart-required 时
  // 运行时视图版本号不变，会每轮误判为待更新）
  const recentAttempts = new Map(); // `${name}@${latest}` -> ts
  const ATTEMPT_TTL = 24 * 3600 * 1000;

  async function checkAndApplyPlugins(report, { exemptQuiet = false, successes = [] } = {}) {
    const pm = ctx.pluginManager;
    if (!pm?.listBundles || !pm?.installBundle) return;
    const now = Date.now();
    for (const [k, ts] of recentAttempts) if (now - ts > ATTEMPT_TTL) recentAttempts.delete(k);
    const bundles = await pm.listBundles();
    const items = (bundles ?? []).filter((b) => {
      if (!b?.installed || !b?.removable || b.name === 'dsh-autoupdater') return false;
      // link:/file:/workspace: 是本地开发目录，GitHub/tarball 是固定来源：npm 上的同名包
      // 不是同一个东西（例如本地 @fffangchenghao/dsh-web-search 与 registry 同名包）。
      // 用 registry 版本号去“升级”它们会把本地插件整个换掉，必须跳过。
      const source = typeof b.source === 'string' ? b.source : '';
      if (/(?:^|@)(?:link|file|workspace):/i.test(source)) return false;
      if (/^(?:git\+|github:|gitlab:|bitbucket:|https?:|ssh:)/i.test(source)) return false;
      return true;
    });
    // 动手前的门：手动触发只要求"此刻无运行中会话"（豁免静默等待）；
    // 定时触发走完整空闲判定（无会话 + 静默满 idleSeconds）。
    const gate = exemptQuiet ? () => !anyAgentRunning() : isIdle;
    // 网络熔断：连续 4 个包查询失败即中止本轮（网络整体不可用时，
    // 与其 24 个包 × 30s 干等 12 分钟，不如尽快放弃，下轮再试）
    let consecutiveNetFails = 0;
    const NET_FAIL_LIMIT = 4;
    for (const b of items) {
      if (consecutiveNetFails >= NET_FAIL_LIMIT) {
        report.push(`⚠ 连续 ${NET_FAIL_LIMIT} 个包网络超时，中止本轮（网络恢复后下轮自动重试）`);
        break;
      }
      const decision = decide(b.name);
      if (decision === 'skip') continue;
      try {
        const latest = await npmLatestVersion(b.name);
        consecutiveNetFails = 0;
        if (!latest || !semverGt(latest, b.version)) continue;
        const key = `${b.name}@${latest}`;
        if (recentAttempts.has(key)) {
          report.push(`${b.name} ${b.version} → ${latest} (24h 内已尝试，跳过重复安装)`);
          continue;
        }
        const line = `${b.name} ${b.version} → ${latest} (${decision})`;
        report.push(line);
        if (decision !== 'auto') continue;
        if (!gate()) { report.push(`  ⚠ 空闲丢失，跳过 ${b.name}`); continue; }
        // 显式带 @version：installBundle(裸名) 对精确钉版的包只会"确保已装"（pnpm 跳过），
        // 不会升级——这是假更新的根因。
        //
        // 桌面 App 直接走安装包自带的 desktop CLI：
        //  - pluginManager 在带 HMR 的实时 profile 里拒绝替换已装包（already-installed）；
        //  - 普通 `dsh` CLI 拒绝 desktop 保留 profile，且 Electron 可执行文件旁没有 dsh。
        let result;
        if (isDesktopApp()) {
          const cli = await runPluginCliAdd(b.name, latest);
          result = cli.ok
            ? { application: 'restart-required', via: 'cli', output: cli.output }
            : { application: 'failed', error: { code: 'cli-failed', diagnostic: cli.reason } };
        } else {
          result = await pm.installBundle(`${b.name}@${latest}`);
          // DSH 0.2.1+ 的 pluginManager 在「实时 profile」里拒绝替换已装包
          // （ManagementError.code = already-installed，守卫见 dsh-plugin-manager:1991）。
          // 此时退回 CLI 路径：`dsh plugin --profile <p> add <pkg>@<ver>`——独立进程写盘，
          // 装完标记 restart-required，正是官方推荐的换版方式。
          if (result?.application === 'failed' && result?.error?.code === 'already-installed') {
            log(`plugin ${b.name}: service API refused (already-installed) → fallback to CLI`);
            const cli = await runPluginCliAdd(b.name, latest);
            result = cli.ok
              ? { application: 'restart-required', via: 'cli', output: cli.output }
              : { application: 'failed', error: { code: 'cli-failed', diagnostic: cli.reason } };
          }
        }
        // 装完回读磁盘真实版本验证，不再信返回值
        let diskVer = null;
        if (profileDir) {
          const diskPkg = await readJson(`${profileDir}/node_modules/${b.name}/package.json`).catch(() => null);
          diskVer = diskPkg?.version ?? null;
        }
        const reallyUpdated = diskVer == null ? true : diskVer !== b.version; // 无 profileDir 时退化为信安装结果
        const reported = result?.application === 'applied' || result?.application === 'restart-required';
        // CLI 已换版、但收尾 reconcile 失败（非 0 退出）时，磁盘才是唯一事实：
        // package.json/node_modules 真变了，就按“已装、待重启”处理。
        const cliTouchedDisk = result?.error?.code === 'cli-failed' && reallyUpdated;
        const ok = reallyUpdated && (reported || cliTouchedDisk);
        // 只有真正装上了才抑制 24h 重复安装；失败要允许下一轮重试（原实现失败也记 24h，
        // 一次网络抖动会让这个包一整天不再尝试）。
        if (ok) {
          recentAttempts.set(key, now);
          successes.push(line);
        }
        // peerDeps 不兼容识别：插件新版要求更新的 DSH 本体，安装器主动拒绝。
        // 归类为"等待 DSH 更新"——不是错误，等 DSH 升级后下轮自动装上；不计入失败重试。
        // 结构化判定优先：官方 ManagementError.code === 'incompatible-version'
        const errCode = result?.error?.code;
        const errMsg = result?.error?.diagnostic || result?.packageResult?.output || '';
        const peerBlocked = errCode === 'incompatible-version'
          || /is incompatible with dsh|incompatible with this dsh runtime/i.test(errMsg);
        log(`plugin update ${b.name}:`, result?.application, `disk=${diskVer}`, reallyUpdated ? '✓' : '✗ 未变化', errMsg ? lastMeaningfulLine(errMsg, 160) : '');
        await appendHistory({ kind: 'plugin', name: b.name, from: b.version, to: latest, outcome: result?.application, diskVer, ...(errMsg ? { reason: String(errMsg).slice(0, 300) } : {}) });
        if (!ok) {
          if (peerBlocked) {
            report.push(`  ⏸ ${b.name} ${latest} 需要更新的 DSH 本体（peerDeps 不兼容），已跳过——等 DSH 官方发布新版后自动安装`);
            await appendHistory({ kind: 'peer-blocked', name: b.name, to: latest });
          } else {
            const why = errMsg ? ` — ${lastMeaningfulLine(errMsg)}` : '';
            report.push(`  ✗ ${b.name} 更新失败: ${result?.application}${reallyUpdated ? '' : `（磁盘仍为 ${diskVer}）`}${why}`);
          }
        } else if (cliTouchedDisk) {
          report.push(`  ⚠ ${b.name} 已写到 ${diskVer}，但 CLI 收尾报错（退出码 ${result?.error?.code === 'cli-failed' ? '非 0' : '?'}）——重启后确认`);
        }
      } catch (e) {
        log(`plugin check ${b.name} failed:`, e?.message);
        consecutiveNetFails++;
      }
    }
  }

  // ---- 主循环 ----
  let harnessNotice = null;
  let running = false;

  async function runCheck(trigger) {
    if (running) return;
    running = true;
    try {
      await reloadHotConfig();
      log(`check start (${trigger})`);
      state.lastRun = new Date().toISOString();

      let got;
      if (trigger === 'manual') {
        // 立即检查语义：无运行中会话 → 立即开始（不等 idleSeconds 静默）；
        // 有会话运行 → 轮询等待其结束，最多 idleTimeoutMinutes。
        const deadline = nowSec() + config.idleTimeoutMinutes * 60;
        got = false;
        while (nowSec() < deadline) {
          if (!anyAgentRunning()) { got = true; break; }
          await sleep(10000);
        }
      } else {
        got = await waitIdle(config.idleTimeoutMinutes * 60);
      }
      if (!got) {
        log('idle window not reached, skip this round');
        state.lastRun += ' (skipped: busy)';
        await saveState();
        return;
      }

      const report = [];
      const successes = [];
      await checkAndApplyPlugins(report, { exemptQuiet: trigger === 'manual', successes });
      try {
        await checkHarness(report);
      } catch (e) {
        // 本体检查的网络失败不应抹掉本轮插件检查的成果（report 已有部分结果）
        report.push(`⚠ 本体检查失败（网络）：${e?.message?.slice(0, 80)}`);
        log('harness check failed (network):', e?.message);
      }

      // 桌面 App 不能从进程内部重启：把“需要重启才生效”写进本轮结果，面板里直接可见。
      // 只统计真正成功的 upgrade（successes），失败/跳过/仅通知的版本行不算。
      if (successes.length > 0 && isDesktopApp()) {
        report.push('  ⏻ 插件已更新到磁盘，重启 DeepSeek Harness 后生效');
      }

      state.updates = report;
      state.lastError = null;
      await saveState();
      await appendHistory({ kind: 'check', trigger, findings: report });
      log('check done:', report.length ? report : 'no updates');

      // 立即检查且本轮有实际更新动作 → 延时 10 秒重启 DSH，
      // 让 restart-required 的新插件与本体重启一并生效。
      // 只把真正装上的插件算作“已应用”；旧实现按报告里的版本行匹配，
      // 更新失败时也会触发一次重启（并在 macOS 上撞上 currentArgv 为 null）。
      const pluginOnly = successes;
      // 手动检查的"10 秒后重启"只适用于纯插件更新（无需 npm install）。
      // 本体更新必须走 staged → 宽限期 → 安装并校验 → 重启，绝不能 10 秒就杀进程
      // （2026-10-18 事故：10 秒重启抢在 npm install 之前，服务空停 61 分钟）。
      const hadHarnessStage = report.some((line) => typeof line === 'string' && /\(staged\)$/.test(line));
      if (trigger === 'manual' && pluginOnly.length > 0 && !hadHarnessStage) {
        if (isDesktopApp()) {
          log('desktop build: plugin files updated — restart required, not restarting in-process');
          await appendHistory({ kind: 'restart-required', reason: 'desktop-app', updates: pluginOnly });
          return;
        }
        log(`plugin updates applied (${pluginOnly.length}), restart DSH in 10s`);
        await appendHistory({ kind: 'manual-restart-scheduled', updates: pluginOnly, inSeconds: 10 });
        await sleep(10000);
        await applyHarnessUpdateNow();
        return;
      }
      if (hadHarnessStage) {
        log('harness update staged — deferring apply to grace period (no immediate restart)');
        await appendHistory({ kind: 'harness-stage-deferred', graceMinutes: config.graceMinutes });
        return;
      }
    } catch (e) {
      log('check error:', e?.message ?? e);
      state.lastError = String(e?.message ?? e);
      await appendHistory({ kind: 'error', trigger, message: String(e?.message ?? e) });
    } finally {
      running = false;
    }
  }

  // ---- 宽限期 tick ----
  let applyingHarness = false;
  async function tick() {
    try {
      if (!harnessNotice || config.harnessMode !== 'auto') return;
      if (applyingHarness) return;
      const quietFor = nowSec() - Math.max(harnessNotice.from, lastActivity);
      if (quietFor >= config.graceMinutes * 60 && !anyAgentRunning()) {
        applyingHarness = true;
        await applyHarnessUpdateNow(); // 更新脚本装到独立单元后自行完成安装+重启
        harnessNotice = null;
        applyingHarness = false;
      }
    } catch (e) { applyingHarness = false; log('tick error:', e?.message); }
  }

  // ---- 调度（四种模式；触发后按新配置重排）----
  let scheduleTimer = null;
  let graceTimer = null;

  function reschedule() {
    if (scheduleTimer) { clearTimeout(scheduleTimer); scheduleTimer = null; }
    const at = nextRunAt(config);
    if (!(at > 0)) return;
    const delay = Math.max(1000, at - Date.now());
    scheduleTimer = setTimeout(() => {
      runCheck(config.scheduleMode).catch(() => {});
      reschedule();
    }, delay);
    scheduleTimer.unref?.();
    const when = new Date(at).toLocaleString('zh-CN', { hour12: false });
    log(`next check: ${when} (mode=${config.scheduleMode})`);
  }

  // ---- Web API ----
  function sendJson(res, code, obj) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c) => { data += c; if (data.length > 64 * 1024) { reject(new Error('body too large')); req.destroy(); } });
      req.on('end', () => {
        try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
      });
      req.on('error', reject);
    });
  }

  async function installedPluginNames() {
    try {
      const bundles = await ctx.pluginManager.listBundles();
      return (bundles ?? [])
        .filter((b) => b?.installed)
        .map((b) => ({ name: b.name, version: b.version ?? null, removable: !!b?.removable }));
    } catch { return []; }
  }

  /** 最近活动日志（history.jsonl 尾部，供前端展示） */
  async function recentLogs(limit = 50) {
    try {
      const raw = await readFile(historyPath, 'utf8');
      const lines = raw.trim().split('\n').filter(Boolean);
      return lines.slice(-limit).map((l) => {
        try { return JSON.parse(l); } catch { return { at: null, raw: l }; }
      });
    } catch { return []; }
  }

  if (ctx.webServer?.register) {
    try {
      const disposeStatus = ctx.webServer.register({
        kind: 'exact',
        path: '/api/autoupdater/status',
        handler: async (_req, res) => {
          // 诊断：列出每个 agent 的实际状态，定位"恒 running"的来源
          let agentsDetail = null;
          try {
            agentsDetail = (ctx.agents?.list?.() ?? []).map((a) => ({
              id: a.sessionId ?? a.id ?? '?',
              status: a.status,
              kind: a.kind ?? undefined,
            }));
          } catch {}
          sendJson(res, 200, {
            ...state,
            nextRunAt: nextRunAt(config),
            idleForSeconds: idleFor(),
            anyAgentRunning: anyAgentRunning(),
            agentsDetail,
            harnessNotice,
            pendingStaged: existsSync(pendingPath),
            scheduleMode: config.scheduleMode,
            logs: await recentLogs(50),
          });
        },
      });
      if (typeof disposeStatus === 'function') disposers.push(disposeStatus);

      // GET 与 POST 同路径不同方法；webServer 路由不区分方法，这里合并处理
      const disposeConfig = ctx.webServer.register({
        kind: 'exact',
        path: '/api/autoupdater/config',
        handler: async (req, res) => {
          if (req.method === 'GET') {
            sendJson(res, 200, {
              config,
              installed: await installedPluginNames(),
              nextRunAt: nextRunAt(config),
              running,
              ...state,
              logs: await recentLogs(50),
              idleForSeconds: idleFor(),
              anyAgentRunning: anyAgentRunning(),
              harnessNotice,
              pendingStaged: existsSync(pendingPath),
            });
            return;
          }
          if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return; }
          try {
            const body = await readBody(req);
            const prevMode = config.scheduleMode;
            const next = normalizeConfig({ ...config, ...(body ?? {}) });
            await mkdir(stateDir, { recursive: true });
            await writeFile(hotConfigPath, JSON.stringify(next, null, 2));
            config = next;
            reschedule(); // 新配置立即排程
            if (prevMode !== next.scheduleMode) log('schedule mode changed →', next.scheduleMode);
            sendJson(res, 200, { ok: true, config: next, nextRunAt: nextRunAt(next) });
          } catch (e) {
            sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
          }
        },
      });
      if (typeof disposeConfig === 'function') disposers.push(disposeConfig);

      // 手动触发一次检查（不绕过空闲门槛：runCheck 内部照常 waitIdle）
      const disposeRun = ctx.webServer.register({
        kind: 'exact',
        path: '/api/autoupdater/run-now',
        handler: async (_req, res) => {
          if (running) { sendJson(res, 200, { ok: true, queued: false, reason: 'already-running' }); return; }
          runCheck('manual').catch(() => {});
          sendJson(res, 200, { ok: true, queued: true });
        },
      });
      if (typeof disposeRun === 'function') disposers.push(disposeRun);
    } catch (e) { log('route register failed:', e?.message); }
  }

  // ---- 启动 ----
  reloadHotConfig().then(() => {
    reschedule();
    graceTimer = setInterval(tick, 30000);
    graceTimer.unref?.();
  }).catch((e) => log('startup reload failed:', e?.message));

  // ---- 清理 ----
  return () => {
    if (scheduleTimer) clearTimeout(scheduleTimer);
    if (graceTimer) clearInterval(graceTimer);
    for (const d of disposers) { try { d?.(); } catch {} }
  };
}
