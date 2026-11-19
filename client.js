window.__ModuleLoader__.load({
  id: 'dsh-autoupdater',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const SCHEDULE_OPTIONS = [
      { value: 'daily', label: '每日定时', hint: '每天固定时刻检查' },
      { value: 'everyHours', label: '每 N 小时', hint: '整点对齐的间隔检查' },
      { value: 'everyDays', label: '每 N 天', hint: '多天一次 + 锚定时刻' },
      { value: 'everyMinutes', label: '每 N 分钟', hint: '高频轮询检查' },
    ];
    const HARNESS_OPTIONS = [
      { value: 'off', label: '不更新本体', hint: '本体保持当前版本' },
      { value: 'notify', label: '只通知', hint: '有更新时提醒我' },
      { value: 'auto', label: '通知后自动重启', hint: '空闲窗口自动完成' },
    ];
    const PLUGIN_OPTIONS = [
      { value: 'regexmode-ignore', label: '白名单只提醒，其余自动', hint: '白名单敏感，其余自动更新' },
      { value: 'whitelist-auto', label: '白名单自动，其余只提醒', hint: '只放心更新白名单内的插件' },
      { value: 'auto-all', label: '全部自动更新', hint: '所有插件自动保持最新' },
      { value: 'notify-all', label: '全部只提醒', hint: '只报告不改动' },
      { value: 'off', label: '不更新插件', hint: '暂停插件自动更新' },
    ];

    // ───────────────────────── 主题 token 快捷引用 ─────────────────────────
    const T = {
      text: 'var(--dsw-alias-label-primary)',
      text2: 'var(--dsw-alias-label-secondary)',
      text3: 'var(--dsw-alias-label-tertiary)',
      caption: 'var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary))',
      border: 'var(--dsw-alias-border-l4, var(--dsw-alias-border-l3, var(--dsw-alias-label-tertiary)))',
      bg1: 'var(--dsw-alias-bg-layer-1, transparent)',
      bg2: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-3))',
      bg3: 'var(--dsw-alias-bg-layer-3)',
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      brand: 'var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary))',
      btnFill: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary)))',
      btnHover: 'var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-dimmed, var(--dsw-alias-button-primary-fill)))',
      btnLabel: 'var(--dsw-alias-label-primary-foreground, #fff)',
      success: 'var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary))',
      error: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary, var(--dsw-alias-state-business-primary))',
      focusRing: 'var(--dsw-focus-ring-color)',
      focusWidth: 'var(--dsw-focus-ring-width, 2px)',
      radiusXs: 'var(--dsw-radius-xs, 4px)',
      radiusSm: 'var(--dsw-radius-sm)',
      radiusMd: 'var(--dsw-radius-md)',
      radiusLg: 'var(--dsw-radius-lg)',
      radiusXl: 'var(--dsw-radius-xl, var(--dsw-radius-lg))',
      mono: 'var(--dsw-font-mono, monospace)',
    };

    // focus-visible 描边（键盘可达）
    const focusable = {
      ':focus-visible': {
        outline: `${T.focusWidth} solid ${T.focusRing}`,
        outlineOffset: 2,
      },
    };

    // ───────────────────────── 基础视觉构件 ─────────────────────────

    // 面板外壳：统一的卡片容器
    function Card({ title, icon, children, style }) {
      return h('section', {
        style: {
          background: T.bg2,
          border: `1px solid ${T.border}`,
          borderRadius: T.radiusLg,
          padding: '14px 16px 16px',
          ...style,
        },
      },
        title && h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 8,
            marginBottom: 12,
          },
        },
          icon && h('span', { style: { fontSize: 14, lineHeight: 1 }, 'aria-hidden': true }, icon),
          h('h3', { style: { margin: 0, fontSize: 13, fontWeight: 600, letterSpacing: 0.2, color: T.text } }, title),
        ),
        children);
    }

    // 字段：标签 + 控件 + 说明
    function Field({ label, hint, style, children }) {
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0, ...style } },
        h('label', { style: { fontSize: 12, fontWeight: 500, color: T.text2 } }, label),
        children,
        hint && h('span', { style: { fontSize: 11, color: T.caption } }, hint));
    }

    const inputStyle = {
      padding: '7px 10px',
      borderRadius: T.radiusSm,
      border: `1px solid ${T.border}`,
      background: T.bg1,
      color: T.text,
      fontSize: 13,
      width: '100%',
      boxSizing: 'border-box',
      transition: 'border-color 150ms ease, background 150ms ease',
    };
    const inputEvents = {
      onFocus: (e) => { e.target.style.borderColor = T.brand; },
      onBlur: (e) => { e.target.style.borderColor = T.border; },
    };

    // 主按钮（品牌填充）
    function PrimaryButton({ children, onClick, disabled, style }) {
      const [hover, setHover] = React.useState(false);
      return h('button', {
        onClick, disabled,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          padding: '8px 18px',
          borderRadius: T.radiusSm,
          border: 'none',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.55 : 1,
          fontSize: 13, fontWeight: 600,
          background: hover && !disabled ? T.btnHover : T.btnFill,
          color: T.btnLabel,
          transition: 'background 150ms ease, transform 150ms ease, box-shadow 150ms ease',
          transform: hover && !disabled ? 'translateY(-1px)' : 'none',
          boxShadow: hover && !disabled ? '0 4px 12px rgba(0,0,0,0.18)' : 'none',
          ...focusable,
          ...style,
        },
      }, children);
    }

    // 次按钮（描边）
    function GhostButton({ children, onClick, disabled, style }) {
      const [hover, setHover] = React.useState(false);
      return h('button', {
        onClick, disabled,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          padding: '7px 14px',
          borderRadius: T.radiusSm,
          border: `1px solid ${hover && !disabled ? T.brand : T.border}`,
          background: hover && !disabled ? T.hover : 'transparent',
          color: T.text,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.55 : 1,
          fontSize: 13, fontWeight: 500,
          transition: 'all 150ms ease',
          ...focusable,
          ...style,
        },
      }, children);
    }

    // 分段选择器（触发方式）
    function Segmented({ options, value, onChange }) {
      const [hovered, setHovered] = React.useState(null);
      return h('div', {
        role: 'radiogroup', 'aria-label': '触发方式',
        style: {
          display: 'flex', flexWrap: 'wrap', gap: 2,
          padding: 3, borderRadius: T.radiusMd,
          background: T.bg3, border: `1px solid ${T.border}`,
        },
      },
        options.map((o) => {
          const active = o.value === value;
          const hover = hovered === o.value;
          return h('button', {
            key: o.value,
            role: 'radio', 'aria-checked': active,
            title: o.hint,
            onClick: () => onChange(o.value),
            onMouseEnter: () => setHovered(o.value),
            onMouseLeave: () => setHovered(null),
            style: {
              flex: '1 1 auto',
              padding: '6px 10px',
              borderRadius: T.radiusXs,
              border: active ? `1px solid ${T.border}` : '1px solid transparent',
              background: active ? T.bg1 : hover ? T.hover : 'transparent',
              color: active ? T.text : T.text2,
              fontSize: 12, fontWeight: active ? 600 : 400,
              cursor: 'pointer',
              transition: 'all 150ms ease',
              ...focusable,
            },
          }, o.label);
        }));
    }

    // 选项卡片（更新策略：一列可选卡片，比下拉直观）
    function OptionCards({ options, value, onChange, name }) {
      return h('div', { role: 'radiogroup', 'aria-label': name, style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        options.map((o) => {
          const active = o.value === value;
          const [hover, setHover] = React.useState(false);
          return h('button', {
            key: o.value,
            role: 'radio', 'aria-checked': active,
            onClick: () => onChange(o.value),
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false),
            style: {
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 12px',
              borderRadius: T.radiusSm,
              border: `1px solid ${active ? T.brand : hover ? T.brand : T.border}`,
              background: active ? T.hover : hover ? T.hover : T.bg1,
              cursor: 'pointer', textAlign: 'left',
              transition: 'all 150ms ease',
              ...focusable,
            },
          },
            // 选中指示点
            h('span', {
              'aria-hidden': true,
              style: {
                flexShrink: 0, width: 12, height: 12, borderRadius: '50%',
                border: `2px solid ${active ? T.brand : T.text3}`,
                background: active ? T.brand : 'transparent',
                transition: 'all 150ms ease',
              },
            }),
            h('span', { style: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 } },
              h('span', { style: { fontSize: 13, fontWeight: active ? 600 : 500, color: T.text } }, o.label),
              h('span', { style: { fontSize: 11, color: T.caption } }, o.hint)));
        }));
    }

    // 白名单 chip
    function Chip({ name, onRemove }) {
      const [hover, setHover] = React.useState(false);
      return h('span', {
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '3px 6px 3px 10px',
          borderRadius: 999,
          border: `1px solid ${T.border}`,
          background: T.bg3,
          fontSize: 12, color: T.text,
          transition: 'all 150ms ease',
        },
      },
        h('span', { style: { fontFamily: T.mono, fontSize: 11 } }, name),
        h('button', {
          onClick: onRemove,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          'aria-label': `移除 ${name}`,
          style: {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 16, height: 16, borderRadius: '50%',
            border: 'none', cursor: 'pointer', padding: 0, fontSize: 12, lineHeight: 1,
            background: hover ? T.error : 'transparent',
            color: hover ? T.btnLabel : T.text3,
            transition: 'all 150ms ease',
            ...focusable,
          },
        }, '×'));
    }

    // 状态指标块
    function Stat({ label, value, sub, tone }) {
      return h('div', {
        style: {
          flex: '1 1 120px', minWidth: 110,
          padding: '10px 12px',
          borderRadius: T.radiusMd,
          background: T.bg1,
          border: `1px solid ${T.border}`,
        },
      },
        h('div', { style: { fontSize: 11, color: T.caption, marginBottom: 4 } }, label),
        h('div', {
          style: {
            fontSize: 14, fontWeight: 600, fontFamily: T.mono, fontSize: 13,
            color: tone || T.text,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          },
        }, value),
        sub && h('div', { style: { fontSize: 11, color: T.text3, marginTop: 3 } }, sub));
    }

    function formatNext(ts) {
      if (!ts) return '未排程';
      return new Date(ts).toLocaleString('zh-CN', { hour12: false });
    }

    // ───────────────────── 最近活动日志 ─────────────────────

    /** 一条 history 记录转一行可读日志 */
    function logLine(entry) {
      const t = entry.at ? new Date(entry.at).toLocaleString('zh-CN', { hour12: false }) : '—';
      switch (entry.kind) {
        case 'check': {
          const n = Array.isArray(entry.findings) ? entry.findings.filter((f) => /\(auto\)$|\(staged\)$/.test(f)).length : 0;
          return { tone: n > 0 ? 'ok' : 'dim', text: `检查完成（${entry.trigger}）：${n ? `发现并处理 ${n} 项更新` : '无需更新'}` };
        }
        case 'plugin':
          return { tone: 'ok', text: `插件更新：${entry.name} ${entry.from} → ${entry.to}（${entry.outcome === 'restart-required' ? '已安装，重启后生效' : entry.outcome === 'applied' ? '已即时生效' : entry.outcome}）` };
        case 'harness-restart':
          return { tone: 'warn', text: `DSH 本体重启更新：→ ${entry.to ?? '?'}` };
        case 'harness-applied':
          return { tone: entry.applied ? 'ok' : 'error', text: `本体更新落盘：${entry.from ?? '?'} → ${entry.applied ?? entry.to ?? '失败'}` };
        case 'manual-restart-scheduled':
          return { tone: 'warn', text: `手动检查触发重启（10 秒后）` };
        case 'error':
          return { tone: 'error', text: `出错：${entry.message ?? entry.raw ?? '?'}` };
        default:
          return { tone: 'dim', text: entry.raw ?? entry.kind ?? JSON.stringify(entry).slice(0, 60) };
      }
    }

    function LogList({ logs }) {
      const [open, setOpen] = React.useState(false);
      const shown = open ? logs : logs.slice(-5);
      return h('div', { style: { marginTop: 12 } },
        h('div', {
          role: 'button', tabIndex: 0,
          onClick: () => setOpen((v) => !v),
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') setOpen((v) => !v); },
          style: {
            display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
            fontSize: 12, color: T.text2, userSelect: 'none', padding: '4px 0',
          },
        }, `${open ? '▾' : '▸'} 最近活动（${logs.length} 条）`),
        h('div', {
          style: {
            display: 'flex', flexDirection: 'column', gap: 4,
            maxHeight: open ? 260 : 140, overflowY: 'auto',
          },
        }, shown.slice().reverse().map((e, i) => {
          const { tone, text } = logLine(e);
          const color = tone === 'ok' ? T.success : tone === 'warn' ? T.warn : tone === 'error' ? T.error : T.text3;
          const t = e.at ? new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false }) : '';
          return h('div', {
            key: i,
            style: { display: 'flex', gap: 8, fontSize: 12, lineHeight: '18px' },
          },
            h('span', { style: { color: T.text3, fontFamily: T.mono, flexShrink: 0 } }, t),
            h('span', { style: { color } }, text));
        })));
    }

    // ───────────────────────── 主应用 ─────────────────────────

    function App() {
      const [data, setData] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [saveMsg, setSaveMsg] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [manualMsg, setManualMsg] = React.useState(null);

      const load = React.useCallback(async () => {
        try {
          const r = await fetch('/api/autoupdater/config');
          const j = await r.json();
          setData(j);
          setDraft((d) => d ?? j.config);
        } catch { setData({ error: '无法连接状态接口' }); }
      }, []);

      React.useEffect(() => {
        load();
        const t = setInterval(load, 30000);
        return () => clearInterval(t);
      }, [load]);

      const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));

      const save = async () => {
        setBusy(true); setSaveMsg(null);
        try {
          const r = await fetch('/api/autoupdater/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(draft),
          });
          const j = await r.json();
          if (j.ok) {
            setDraft(j.config);
            setData((d) => ({ ...d, config: j.config, nextRunAt: j.nextRunAt }));
            setSaveMsg({ ok: true, text: '✓ 已保存，立即生效' });
          } else {
            setSaveMsg({ ok: false, text: `保存失败：${j.error}` });
          }
        } catch (e) {
          setSaveMsg({ ok: false, text: `保存失败：${e.message}` });
        } finally { setBusy(false); }
      };

      const runNow = async () => {
        setManualMsg(null);
        try {
          const r = await fetch('/api/autoupdater/run-now', { method: 'POST' });
          const j = await r.json();
          setManualMsg({ ok: !!j.queued, text: j.queued
            ? '✓ 已触发：无运行中会话则立即检查；有会话则等其结束后执行'
            : `未触发：${j.reason === 'already-running' ? '已有检查在跑' : j.reason}` });
        } catch (e) { setManualMsg({ ok: false, text: `触发失败：${e.message}` }); }
      };

      const addWhitelist = (name) => {
        if (!name || draft.whitelist.includes(name)) return;
        set('whitelist', [...draft.whitelist, name]);
      };
      const removeWhitelist = (name) =>
        set('whitelist', draft.whitelist.filter((n) => n !== name));

      // 加载中骨架
      if (!data) return h('div', { style: { padding: '16px 4px' } },
        [0, 1, 2].map((i) => h('div', {
          key: i,
          style: {
            height: 56, marginBottom: 10, borderRadius: T.radiusLg,
            background: 'var(--dsw-alias-bg-skeleton, ' + T.bg3 + ')',
            opacity: 0.5 - i * 0.12,
            animation: 'dsw-autoupdater-pulse 1.2s ease-in-out infinite',
          },
        })));

      if (data.error) return h(Card, { title: '自动更新' },
        h('div', { style: { color: T.error, fontSize: 13 } }, data.error));

      const cfg = draft ?? data.config;
      const installedChoices = (data.installed ?? []).filter(
        (p) => p.removable && !cfg.whitelist.includes(p.name));
      const st = data;

      return h('div', { style: { padding: '4px 0', fontSize: 13, color: T.text, display: 'flex', flexDirection: 'column', gap: 14 } },

        // ── 状态卡 ──
        h(Card, { key: 'status', title: '运行状态', icon: '📡' },
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
            h(Stat, { label: '下次检查', value: formatNext(st.nextRunAt), sub: `模式：${SCHEDULE_OPTIONS.find((o) => o.value === cfg.scheduleMode)?.label ?? cfg.scheduleMode}` }),
            h(Stat, { label: '上次检查', value: st.lastRun ?? '从未' }),
            h(Stat, {
              label: '当前空闲',
              value: `${st.idleForSeconds ?? 0} 秒`,
              sub: st.anyAgentRunning ? '有会话运行中' : '无运行中会话',
              tone: st.anyAgentRunning ? T.warn : T.success,
            })),

          st.pendingStaged && h('div', {
            role: 'status',
            style: {
              marginTop: 10, padding: '8px 12px',
              borderRadius: T.radiusSm,
              border: `1px solid ${T.warn}`,
              background: T.hover,
              color: T.warn, fontSize: 12, fontWeight: 500,
            },
          }, '⚠ 已暂存 DSH 本体更新，等待空闲重启'),

          st.lastError && h('div', {
            role: 'alert',
            style: {
              marginTop: 10, padding: '8px 12px',
              borderRadius: T.radiusSm,
              border: `1px solid ${T.error}`,
              color: T.error, fontSize: 12,
            },
          }, `上次错误：${st.lastError}`),

          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 } },
            h(GhostButton, { onClick: runNow, disabled: busy }, '⚡ 立即检查一次'),
            manualMsg && h('span', {
              role: 'status',
              style: { fontSize: 12, color: manualMsg.ok ? T.success : T.error },
            }, manualMsg.text)),

          // ── 最近活动日志 ──
          Array.isArray(st.logs) && st.logs.length > 0 && h(LogList, { logs: st.logs }),
        ),

        // ── 触发方式 ──
        h(Card, { key: 'schedule', title: '触发方式', icon: '⏱' },
          h(Segmented, {
            options: SCHEDULE_OPTIONS,
            value: cfg.scheduleMode,
            onChange: (v) => set('scheduleMode', v),
          }),
          h('p', {
            style: { margin: '8px 0 12px', fontSize: 11, color: T.caption },
          }, SCHEDULE_OPTIONS.find((o) => o.value === cfg.scheduleMode)?.hint),

          cfg.scheduleMode === 'daily' && h(Field, { key: 'daily', label: '每日检查时刻（HH:MM）' },
            h('input', { style: { ...inputStyle, maxWidth: 160 }, value: cfg.dailyTime, placeholder: '04:30',
              onChange: (e) => set('dailyTime', e.target.value), ...inputEvents })),

          cfg.scheduleMode === 'everyHours' && h(Field, { key: 'hours', label: '检查间隔（小时，整点对齐，1-168）' },
            h('input', { type: 'number', min: 1, max: 168, style: { ...inputStyle, maxWidth: 160 },
              value: cfg.everyHours, onChange: (e) => set('everyHours', Number(e.target.value)), ...inputEvents })),

          cfg.scheduleMode === 'everyDays' && h('div', { key: 'days', style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
            h(Field, { label: '每几天检查一次（1-365）', style: { maxWidth: 200 } },
              h('input', { type: 'number', min: 1, max: 365, style: inputStyle, value: cfg.everyDays,
                onChange: (e) => set('everyDays', Number(e.target.value)), ...inputEvents })),
            h(Field, { label: '锚定时刻（HH:MM）', style: { maxWidth: 200 } },
              h('input', { style: inputStyle, value: cfg.dailyTime, placeholder: '04:30',
                onChange: (e) => set('dailyTime', e.target.value), ...inputEvents }))),

          cfg.scheduleMode === 'everyMinutes' && h(Field, { key: 'mins', label: '检查间隔（分钟，1-10080）' },
            h('input', { type: 'number', min: 1, max: 10080, style: { ...inputStyle, maxWidth: 160 },
              value: cfg.everyMinutes, onChange: (e) => set('everyMinutes', Number(e.target.value)), ...inputEvents }))),

        // ── 更新策略 ──
        h(Card, { key: 'policy', title: '更新策略', icon: '🛡' },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
            h(Field, { key: 'harness', label: 'DSH 本体更新策略' },
              h(OptionCards, { name: 'DSH 本体更新策略', options: HARNESS_OPTIONS, value: cfg.harnessMode,
                onChange: (v) => set('harnessMode', v) })),
            h(Field, { key: 'pluginMode', label: '插件更新策略' },
              h(OptionCards, { name: '插件更新策略', options: PLUGIN_OPTIONS, value: cfg.pluginMode,
                onChange: (v) => set('pluginMode', v) })))),

        // ── 白名单 ──
        (cfg.pluginMode === 'regexmode-ignore' || cfg.pluginMode === 'whitelist-auto') &&
        h(Card, { key: 'whitelist', title: '白名单', icon: '🏷' },
          h('p', { style: { margin: '0 0 10px', fontSize: 11, color: T.caption } },
            cfg.pluginMode === 'whitelist-auto'
              ? '白名单内的插件会自动更新，其余只提醒。'
              : '白名单内的插件只提醒不自动更新，其余自动更新。'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 } },
            cfg.whitelist.length === 0
              ? h('span', { style: { fontSize: 12, color: T.text3, fontStyle: 'italic' } }, '暂无插件')
              : cfg.whitelist.map((name) => h(Chip, { key: name, name, onRemove: () => removeWhitelist(name) }))),
          h(Field, { label: installedChoices.length
            ? `从已装插件添加（${installedChoices.length} 个可选）`
            : '从已装插件添加（没有可添加的插件）' },
            h('select', {
              style: inputStyle,
              value: '',
              disabled: installedChoices.length === 0,
              onChange: (e) => { addWhitelist(e.target.value); e.target.value = ''; },
            },
              h('option', { value: '' }, '＋ 选择插件…'),
              installedChoices.map((p) => h('option', { key: p.name, value: p.name }, `${p.name} (${p.version ?? '?'})`))))),

        // ── 保存栏（吸底观感） ──
        h('div', {
          key: 'actions',
          style: {
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '12px 14px',
            borderRadius: T.radiusLg,
            background: T.bg2,
            border: `1px solid ${T.border}`,
          },
        },
          h(PrimaryButton, { onClick: save, disabled: busy }, busy ? '保存中…' : '保存设置'),
          saveMsg && h('span', {
            role: 'status',
            style: { fontSize: 12, color: saveMsg.ok ? T.success : T.error },
          }, saveMsg.text)),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 注入一次性的骨架屏动画样式
        if (typeof document !== 'undefined' && !document.getElementById('dsh-autoupdater-style')) {
          const el = document.createElement('style');
          el.id = 'dsh-autoupdater-style';
          el.textContent = '@keyframes dsw-autoupdater-pulse{0%,100%{opacity:.5}50%{opacity:.15}}';
          document.head.appendChild(el);
        }

        // 卡片摘要（插件管理器列表里的一行说明）
        function Summary() {
          const [dg, setDg] = React.useState(null);
          React.useEffect(() => {
            let alive = true;
            const load = () => fetch('/api/autoupdater/digest')
              .then((r) => (r.ok ? r.json() : null))
              .then((d) => { if (alive && d?.hasChanges) setDg(d); })
              .catch(() => {});
            load();
            const timer = setInterval(load, 120000);
            return () => { alive = false; clearInterval(timer); };
          }, []);
          const n = dg ? (dg.counts?.plugins ?? 0) + (dg.counts?.harness ?? 0) : 0;
          return h('span', { style: { color: T.text2, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 } },
            h('span', { 'aria-hidden': true }, '⟳'),
            n > 0
              ? h('span', { style: { color: T.error, fontWeight: 600 } },
                  `有 ${n} 项更新待查看`)
              : '自动更新 · 空闲窗口执行 · 点击进入设置');
        }
        // 详情页（点开卡片后的完整设置面板）
        function Page(props) {
          if (props.view === 'summary') return h(Summary);
          // 详情页：顶部先放"你不在的时候更新了什么"，下面才是设置面板
          return h('div', null, h(DigestBanner), h(App));
        }
        // ─────────────────── 变更汇总（内嵌卡片，不依赖 overlay 定位）───────────────────
        function DigestBanner() {
          const [digest, setDigest] = React.useState(null);
          const [expanded, setExpanded] = React.useState(false);
          const [busy, setBusy] = React.useState(false);

          React.useEffect(() => {
            let alive = true;
            const load = () => fetch('/api/autoupdater/digest')
              .then((r) => (r.ok ? r.json() : null))
              .then((d) => { if (alive && d?.hasChanges) setDigest(d); })
              .catch(() => {});
            load();
            const timer = setInterval(load, 120000);
            return () => { alive = false; clearInterval(timer); };
          }, []);

          if (!digest || !digest.hasChanges) return null;

          const ack = async () => {
            if (busy) return;
            setBusy(true);
            try {
              await fetch('/api/autoupdater/digest', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ at: digest.now }),
              });
              setDigest(null);
            } catch {}
            setBusy(false);
          };

          const row = (key, left, mid, right, color) => h('div', {
            key,
            style: {
              display: 'flex', alignItems: 'baseline', gap: 8,
              padding: '5px 0', fontSize: 13, borderBottom: `1px solid ${T.border}`,
            },
          },
            h('span', { style: { flex: 1, color: T.text, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, left),
            h('span', { style: { color: T.text3, fontSize: 12, fontFamily: 'ui-monospace, monospace' } }, mid),
            h('span', { style: { color, fontSize: 12, flex: 'none' } }, right),
          );

          const allPlugins = digest.plugins || [];
          const shown = expanded ? allPlugins : allPlugins.slice(0, 6);
          const rn = digest.releaseNotes;

          return h('div', {
            style: {
              border: `1px solid ${T.border}`, borderRadius: 'var(--dsw-radius-lg, 12px)',
              padding: '14px 16px', marginBottom: 16, background: T.bg2,
            },
          },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 6 } },
              h('div', {
                style: { fontSize: 14, fontWeight: 600, color: T.text },
              }, '你不在的时候，这些更新了'),
              h('button', {
                type: 'button', onClick: ack, disabled: busy,
                style: {
                  padding: '5px 14px', fontSize: 12, cursor: busy ? 'default' : 'pointer',
                  background: T.btnFill, color: T.btnLabel, border: 'none',
                  borderRadius: 'var(--dsw-radius-md, 8px)', opacity: busy ? 0.6 : 1,
                },
              }, busy ? '处理中…' : '知道了'),
            ),
            h('div', { style: { fontSize: 12, color: T.text3, marginBottom: 10 } },
              `上次确认：${digest.sinceLabel}`),

            (digest.harness || []).length
              ? h('div', { style: { fontSize: 12, fontWeight: 600, color: T.text2, margin: '8px 0 2px' } }, 'DSH 本体')
              : null,
            (digest.harness || []).map((u, i) =>
              row(`h${i}`, 'DSH 本体', `${u.from ?? '?'} → ${u.to ?? '?'}`, u.healthy ? '✓' : '⚠', T.success)),

            rn && rn.highlights && rn.highlights.length
              ? h('div', { style: { marginTop: 8 } },
                  rn.breaking && rn.breaking.length
                    ? h('div', {
                        style: {
                          border: '1px solid var(--dsw-alias-status-error, #d33)',
                          borderRadius: 'var(--dsw-radius-md, 8px)', padding: '6px 9px', margin: '6px 0',
                          fontSize: 12, color: T.error,
                        },
                      }, '⚠ 含破坏性变更：', rn.breaking.join('；'))
                    : null,
                  h('div', { style: { maxHeight: 110, overflowY: 'auto', fontSize: 12, lineHeight: 1.6, color: T.text2 } },
                    rn.highlights.slice(0, 12).map((l, i) => h('div', { key: `rn${i}` }, l))))
              : null,

            allPlugins.length
              ? h('div', { style: { fontSize: 12, fontWeight: 600, color: T.text2, margin: '10px 0 2px' } },
                  `插件 (${allPlugins.length})`)
              : null,
            shown.map((p) => row(`p${p.name}${p.to}`, p.name, `${p.from ?? '?'} → ${p.to ?? '?'}`, p.ok ? '✓' : '✗', p.ok ? T.success : T.error)),
            allPlugins.length > 6
              ? h('button', {
                  type: 'button', onClick: () => setExpanded((v) => !v),
                  style: { background: 'none', border: 'none', padding: '6px 0 0', color: T.brand, fontSize: 12, cursor: 'pointer' },
                }, expanded ? '收起' : `展开全部 ${allPlugins.length} 项`)
              : null,

            (digest.problems || []).length
              ? h('div', { style: { marginTop: 10 } },
                  h('div', { style: { fontSize: 12, fontWeight: 600, color: T.text2, marginBottom: 2 } },
                    `需要注意 (${digest.problems.length})`),
                  digest.problems.map((m, i) => h('div', {
                    key: `x${i}`, style: { fontSize: 12, color: T.error, lineHeight: 1.6 },
                  }, '• ', m)))
              : null,
          );
        }

        // ─────────────────── 变更汇总弹窗（shell.overlay）───────────────────
        // 班总 2026-11-19 要求：升级发生在深夜空闲时段，人不在；之后任何时刻
        // 打开网页都要看到「我离开后你更新了什么」。判据是"上次点知道了"而非
        // "上次打开页面"——打开没看等于没看到。
        function DigestModal(props) {
          const { digest, onAck } = props;
          const [busy, setBusy] = React.useState(false);
          // ⚠ 所有 hooks 必须在提前 return 之前——否则 digest 由 null 变有值时
          // hook 数量变化 → React #310 → "slot entry crashed in shell.overlay"
          const [expanded, setExpanded] = React.useState(false);
          if (!digest || !digest.hasChanges) return null;

          const rowStyle = {
            display: 'flex', alignItems: 'baseline', gap: 8,
            padding: '7px 0', borderBottom: `1px solid ${T.border}`, fontSize: 13,
          };
          const verStyle = { color: T.text3, fontFamily: 'ui-monospace, monospace', fontSize: 12 };

          const sectionTitle = (text, count) => h('div', {
            style: {
              fontSize: 12, fontWeight: 600, color: T.text2, letterSpacing: '.02em',
              margin: '16px 0 4px', textTransform: 'uppercase',
            },
          }, text, count != null ? ` (${count})` : '');

          const allPlugins = digest.plugins || [];
          const COLLAPSED = 8;
          const shownPlugins = expanded ? allPlugins : allPlugins.slice(0, COLLAPSED);
          const pluginRows = shownPlugins.map((p) => h('div', { key: `p:${p.name}@${p.to}`, style: rowStyle },
            h('span', { style: { flex: 1, color: T.text, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, p.name),
            h('span', { style: verStyle }, `${p.from ?? '?'} → ${p.to ?? '?'}`),
            h('span', { style: { color: p.ok ? T.success : T.error, fontSize: 12, flex: 'none' } }, p.ok ? '✓' : '✗'),
          ));

          const harnessRows = (digest.harness || []).map((u, i) => h('div', { key: `h:${i}`, style: rowStyle },
            h('span', { style: { flex: 1, color: T.text } }, 'DSH 本体'),
            h('span', { style: verStyle }, `${u.from ?? '?'} → ${u.to ?? '?'}`),
            h('span', { style: { color: T.success, fontSize: 12, flex: 'none' } }, u.healthy ? '✓' : '⚠'),
          ));

          const problemRows = (digest.problems || []).map((msg, i) => h('div', {
            key: `x:${i}`,
            style: { padding: '6px 0', fontSize: 12.5, color: T.error, lineHeight: 1.5 },
          }, '• ', msg));

          const rn = digest.releaseNotes;
          const noteBlock = rn && rn.highlights.length ? h('div', { style: { marginTop: 14 } },
            sectionTitle('本体功能摘要'),
            rn.breaking && rn.breaking.length
              ? h('div', {
                  style: {
                    background: 'color-mix(in srgb, var(--dsw-alias-status-error, #d33) 12%, transparent)',
                    border: `1px solid var(--dsw-alias-status-error, #d33)`,
                    borderRadius: 'var(--dsw-radius-md, 8px)', padding: '8px 10px', margin: '6px 0',
                    fontSize: 12.5, color: T.text,
                  },
                }, '⚠ 含破坏性变更：', rn.breaking.join('；'))
              : null,
            h('div', { style: { maxHeight: 150, overflowY: 'auto', fontSize: 12.5, lineHeight: 1.6, color: T.text2 } },
              rn.highlights.map((line, i) => h('div', {
                key: `rn:${i}`,
                style: { padding: '1px 0', ...(/^[^\-]/.test(line) && line.length < 30 ? { fontWeight: 600, color: T.text, marginTop: 4 } : {}) },
              }, line)),
            ),
            rn.url ? h('a', {
              href: rn.url, target: '_blank', rel: 'noreferrer',
              style: { fontSize: 12, color: T.brand, textDecoration: 'none', display: 'inline-block', marginTop: 6 },
            }, '查看完整 Release Notes →') : null,
          ) : null;

          const ack = async () => {
            if (busy) return;
            setBusy(true);
            try { await onAck(digest.now); } finally { setBusy(false); }
          };

          return h('div', {
            style: {
              position: 'fixed', inset: 0, zIndex: 4000,
              background: 'rgba(0,0,0,.42)', backdropFilter: 'blur(2px)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
            },
            role: 'dialog', 'aria-modal': 'true', 'aria-label': '自动更新汇总',
          }, h('div', {
            style: {
              width: '100%', maxWidth: 560, maxHeight: '82vh', display: 'flex', flexDirection: 'column',
              background: T.bg1, color: T.text,
              border: `1px solid ${T.border}`, borderRadius: 'var(--dsw-radius-lg, 12px)',
              boxShadow: '0 16px 48px rgba(0,0,0,.32)',
            },
          },
            // 头部
            h('div', { style: { padding: '16px 20px 10px', borderBottom: `1px solid ${T.border}` } },
              h('div', { style: { fontSize: 15, fontWeight: 600 } }, '你不在的时候，这些更新了'),
              h('div', { style: { fontSize: 12, color: T.text3, marginTop: 4 } },
                `上次确认：${digest.sinceLabel}`),
            ),
            // 正文
            h('div', { style: { padding: '4px 20px 8px', overflowY: 'auto', flex: 1 } },
              harnessRows.length ? sectionTitle('DSH 本体', harnessRows.length) : null,
              harnessRows,
              noteBlock,
              pluginRows.length ? sectionTitle('插件', allPlugins.length) : null,
              pluginRows,
              allPlugins.length > COLLAPSED ? h('button', {
                type: 'button',
                onClick: () => setExpanded((v) => !v),
                style: {
                  marginTop: 6, background: 'none', border: 'none', padding: 0,
                  color: T.brand, fontSize: 12.5, cursor: 'pointer',
                },
              }, expanded ? '收起' : `展开全部 ${allPlugins.length} 项`) : null,
              problemRows.length ? sectionTitle('需要注意', problemRows.length) : null,
              problemRows,
            ),
            // 底部
            h('div', {
              style: {
                padding: '12px 20px', borderTop: `1px solid ${T.border}`,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
              },
            },
              h('span', { style: { fontSize: 11.5, color: T.text3 } },
                '确认后不再重复提示，直到下次有新更新'),
              h('button', {
                type: 'button', onClick: ack, disabled: busy,
                style: {
                  padding: '7px 20px', fontSize: 13, fontWeight: 500,
                  background: T.btnFill, color: T.btnLabel, border: 'none',
                  borderRadius: 'var(--dsw-radius-md, 8px)', cursor: busy ? 'default' : 'pointer',
                  opacity: busy ? 0.6 : 1,
                },
              }, busy ? '处理中…' : '知道了'),
            ),
          ));
        }

        // 弹窗宿主：拉取 digest → 有变更就挂载
        function DigestHost() {
          const [digest, setDigest] = React.useState(null);
          React.useEffect(() => {
            let alive = true;
            const load = async () => {
              try {
                const r = await fetch('/api/autoupdater/digest');
                if (!r.ok) return;
                const d = await r.json();
                if (alive && d?.hasChanges) setDigest(d);
              } catch {}
            };
            load();
            // 升级可能发生在页面打开期间（空闲窗口），每 2 分钟复查一次
            const timer = setInterval(load, 120000);
            return () => { alive = false; clearInterval(timer); };
          }, []);

          const ack = async (at) => {
            try {
              await fetch('/api/autoupdater/digest', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ at }),
              });
            } catch {}
            setDigest(null);
          };

          // 直接返回 Modal：它自身 position:fixed，覆盖整个视口。
          // 之前包一层无定位的 div，会把 fixed 元素的层叠上下文限制住。
          return h(DigestModal, { digest, onAck: ack });
        }

        // shell.overlay 是 kind:'list' 的容器槽 —— 必须用 children 声明真正的组件槽，
        // 并把数据通过 inject 注入（官方 ui-chat 的额度提示就是这么做的）。
        // 直接 register 组件会被当成"容器条目"而永远不渲染。
        // 官方 ui-chat 的同构写法：
        //   1) 在 shell.overlay 注册一个"宿主条目"，声明 children 子槽；
        //   2) 宿主的组件用 props.renderSlotChain 渲染子槽；
        //   3) 子槽本身要单独 register 组件 —— 只声明 children 不会自动挂载任何东西。
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-autoupdater-digest',
          children: { 'autoupdater.digest': { kind: 'single', scope: 'root' } },
        }, function OverlayHost(props) {
          // single 槽用 renderSlot
          if (props && typeof props.renderSlot === 'function') {
            return props.renderSlot('autoupdater.digest', {});
          }
          return null;
        }));

        // 子槽：真正承载弹窗组件。
        // 关键：只声明 children 不会挂载任何东西，子槽必须单独 register 一次。
        ctx.slots.inject('autoupdater.digest', () => ctx.slots.register({
          name: 'autoupdater.digest',
          id: 'dsh-autoupdater-digest-content',
        }, DigestHost));

        ctx.slots.inject('plugins.item', () => ctx.slots.register({
          name: 'plugins.item',
          id: 'dsh-autoupdater',
          order: 30,
          label: '自动更新',
          locale: 'dsh-autoupdater',
        }, Page));
      },
    };
  },
});
