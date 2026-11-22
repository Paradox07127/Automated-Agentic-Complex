import { useState } from 'react';
import { useWidth } from '../../charts/useWidth';
import { Btn } from '../../ui';
import { useSettings } from './ctx';
import { KERNEL_LABEL } from './fields';
import { DESTS, OutboundMatrix, useOutboundRows, type Dest, type MatrixRow } from './OutboundMatrix';
import rowStyles from './rows.module.css';
import styles from './Outbound.module.css';

const DEST_LABEL: Record<Dest, string> = {
  local: '[本机]',
  cloud: '[云端]',
};

/** 外发总览 (隐私 group): the way to today's screenshots on 每日简报 and the count of items sent out; [展开] shows the flow map and the route table. */
export function OutboundPlate() {
  const { diag, model, hl, goPage } = useSettings();
  const rows = useOutboundRows();
  const kernel = model.value('kernel');
  const sub: Record<Dest, string> = {
    local: '记忆 │ 本地模型',
    cloud: (typeof kernel === 'string' && KERNEL_LABEL[kernel]) || '角色内核',
  };
  const red = diag.redactions?.reduce((n, r) => n + r.count, 0) ?? null;
  const cloudAllowed = rows.some((r) => r.to.cloud?.on == null && r.to.cloud) ? '—' : rows.filter((r) => r.to.cloud?.on === true).length;
  const [open, setOpen] = useState(false);
  return (
    <section id="set-out" className={[rowStyles.slab, hl === 'out' && rowStyles.hl].filter(Boolean).join(' ')} data-variant="plate" data-row="out" data-nav-target="set-out" aria-label="外发总览">
      <div className={styles.head}>
        <h3 className={styles.title}>外发总览</h3>
        <span className={styles.cap}>当前配置的传输范围</span>
      </div>
      <div className={styles.figs}>
        {diag.screenshots && (
          <div className={styles.fig}>
            <Btn size="sm" variant="secondary" onClick={() => goPage({ page: 'overview' })}>在每日简报看今天的截图</Btn>
          </div>
        )}
        <div className={styles.fig}>
          <span className={styles.figName}>允许送往云端的类型</span>{' '}
          <span className={styles.figNum}>
            <span className="num">{cloudAllowed}</span>
            <small> 项</small>
          </span>
        </div>
      </div>
      <button type="button" className={styles.fold} aria-expanded={open} aria-controls="set-out-more" onClick={() => setOpen(!open)}>
        {open ? '收起' : '展开'}
      </button>
      {open && (
        <div id="set-out-more" className={styles.unfolded}>
          <OutboundFlow rows={rows} sub={sub} redactions={red} />
          <details className={styles.more}>
            <summary>
              <span>读取范围与目的地</span>
              <span className="num">{rows.length} 项</span>
            </summary>
            <OutboundMatrix rows={rows} />
          </details>
        </div>
      )}
    </section>
  );
}

const SOURCES: Array<[key: string, label: string]> = [
  ['shot', '截图'],
  ['wintext', '窗口文字'],
  ['web', '网页正文'],
  ['typing', '输入的文字'],
  ['agent_sessions', '编码会话'],
];

/** Flow map: sources → local agentd (redaction) → destinations; open routes in the ink line, closed ones thin and marked「关」. A route opens its setting. */
function OutboundFlow({ rows, sub, redactions }: { rows: MatrixRow[]; sub: Record<Dest, string>; redactions: number | null }) {
  const { model, goRow } = useSettings();
  const [ref, W] = useWidth<HTMLDivElement>(712);
  const [hv, setHv] = useState<string | null>(null);
  const routes = rows.flatMap((r) => DESTS.flatMap((d) => (r.to[d] ? [{ src: r.key, label: r.label, dest: d, ...r.to[d]! }] : [])));
  const H = 184;
  const sy = (i: number) => 22 + i * 34;
  const dy = (i: number) => 34 + i * 58;
  // Destination column, then at least 120 px of routes between the hub and it.
  const dx = W - (W < 700 ? 196 : 228);
  const ax = Math.max(160, Math.min(Math.round(W * 0.41), dx - 8 - 120 - 62));
  const mid = (ax + 62 + dx - 8) / 2;
  const aria = `外发流向：${
    routes
      .filter((r) => r.on)
      .map((r) => `${r.label}→${DEST_LABEL[r.dest]}`)
      .join('，') || (routes.some((r) => r.on == null) ? '有状态未读到' : '全部关闭')
  }`;
  return (
    <div ref={ref} className={styles.flow}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={aria}>
        {SOURCES.map(([k, l], i) => {
          const live = routes.some((r) => r.src === k && r.on);
          return (
            <g key={k}>
              <text x={88} y={sy(i) + 4} textAnchor="end" className={styles.src} data-hi={hv?.startsWith(`${k}>`) || undefined}>
                {l}
              </text>
              <line x1={94} x2={ax - 30} y1={sy(i)} y2={H / 2} className={styles.in} data-on={live || undefined} />
            </g>
          );
        })}
        <rect x={ax - 30} y={H / 2 - 26} width={92} height={52} className={styles.hub} />
        <text x={ax + 16} y={redactions == null ? H / 2 + 4 : H / 2 - 6} textAnchor="middle" className={styles.hubT}>
          本机后台
        </text>
        {redactions != null && (
          <text x={ax + 16} y={H / 2 + 12} textAnchor="middle" className={styles.sub}>
            遮蔽 {redactions} 次
          </text>
        )}
        {routes.map((r, i) => {
          const di = DESTS.indexOf(r.dest);
          const y0 = H / 2 - 16 + i * 4;
          const y1 = dy(di) - 6 + (i % 3) * 4;
          const d = `M${ax + 62} ${y0}C${mid} ${y0} ${mid} ${y1} ${dx - 8} ${y1}`;
          const id = `${r.src}>${r.dest}`;
          return (
            <g key={id} className={styles.route} data-on={r.on || undefined} data-hi={hv === id || undefined} onMouseEnter={() => setHv(id)} onMouseLeave={() => setHv(null)} onClick={() => goRow(r.row)}>
              <path d={d} className={styles.line} />
              <path d={d} className={styles.hit} />
              {!r.on && (
                <text x={dx - 22} y={y1 - 2} textAnchor="end" className={styles.off}>
                  {r.on == null ? '未读到' : '关'}
                </text>
              )}
              {model.pending[r.row] && (
                <text x={dx - 22} y={y1 + 10} textAnchor="end" className={styles.pend}>
                  ⟳ 重启后生效
                </text>
              )}
              <title>{`${r.label} → ${DEST_LABEL[r.dest]} │ ${r.on == null ? '未读到' : r.on ? '开' : '关'} │ 点击跳到设置行`}</title>
            </g>
          );
        })}
        {DESTS.map((k, i) => (
          <g key={k}>
            <text x={dx} y={dy(i) - 2} className={styles.dest}>
              {DEST_LABEL[k]}
            </text>
            <text x={dx} y={dy(i) + 14} className={styles.sub}>
              {sub[k]}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
