import { ChartState } from '../../charts';
import type { AppTime, BrowserNow } from '../../domain';
import { OpenSec, Region, type RegionSource } from '../../ui';
import s from './Panels.module.css';

export interface WebSecProps {
  /** 区块编号 */
  no: string;
  hosts: AppTime[];
  browser: BrowserNow | null;
  /** /attention/summary?by=domain and /attention/browser together. */
  q: RegionSource<unknown>;
}

const always = () => false;

/** 网站停留：单色细条，当前页所在网站用强调色。 */
function SiteBars({ rows, emph }: { rows: Array<{ host: string; min: number }>; emph: string | null }) {
  const mx = Math.max(1, ...rows.map((r) => r.min));
  return (
    <div className={s.sites} role="img" aria-label={`网站停留分钟：${rows.map((r) => `${r.host} ${r.min} 分`).join('，')}`}>
      {rows.map((r) => (
        <div key={r.host} className={s.site} data-em={r.host === emph || undefined} aria-hidden="true">
          <span className={s.l}>{r.host}</span>
          <span className={s.t}>
            <i style={{ width: `${(r.min / mx) * 100}%` }} />
          </span>
          <span className={`${s.v} num`}>{r.min} 分</span>
        </div>
      ))}
    </div>
  );
}

/** 浏览器与网站（/attention/summary?by=domain、/attention/browser）。 */
export function WebSec(p: WebSecProps) {
  const rows = p.hosts.slice(0, 4).map((h) => ({ host: h.app, min: Math.round(h.seconds / 60) }));
  const cur = p.browser?.current ?? null;
  return (
    <OpenSec no={p.no} title="浏览器与网站" right={<span className={s.cap}>今天 │ 按停留分钟</span>}>
      <Region q={p.q} what="网站" reserve={{ height: 130 }} isEmpty={always}>
        {() => (
          <>
            <ChartState state={rows.length === 0 ? 'empty' : 'ok'} emptyText="今天没有读到网站：可能未允许读取页面文字" height={96}>
              <SiteBars rows={rows} emph={cur?.host ?? null} />
            </ChartState>
            <div className={s.page}>
              <span className={s.k}>当前页</span>
              {cur ? (
                <>
                  <span className={s.url} data-selectable="">
                    {cur.host}
                  </span>
                  <span className={s.cap}>
                    {cur.scroll ? (
                      <>
                        滚动 <span className="num">{cur.scroll.now}%</span> │ 最深 <span className="num">{cur.scroll.deepest}%</span>
                      </>
                    ) : (
                      '页面无需滚动'
                    )}
                    {cur.media && ` │ ${cur.media.kind === 'video' ? '视频' : '音频'}${cur.media.state === 'playing' ? '播放中' : '已暂停'}`}
                  </span>
                </>
              ) : (
                <span className={s.cap}>{p.browser?.connected === false ? '浏览器扩展未连接' : '当前前台不是浏览器'}</span>
              )}
            </div>
          </>
        )}
      </Region>
      <p className={`${s.cap} ${s.foot}`}>无痕窗口始终排除。</p>
    </OpenSec>
  );
}
