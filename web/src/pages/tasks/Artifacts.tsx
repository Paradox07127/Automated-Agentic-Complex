// 产物 (RewardsNode): the shown version, how many were opened, a tile per file with its check bar, the version chain;
// a file's right-click menu opens, reveals, copies its path or writes the previous version back.
import { Fragment, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { revealText } from '../../bridge/platformText';
import { formatClock, type Artifact, type Delivery } from '../../domain';
import { Icon, Modal } from '../../ui';
import type { NativeOff } from './actions';
import { Box, Micro } from './Glyphs';
import styles from './Artifacts.module.css';
import detail from './Detail.module.css';

export interface ArtifactsProps {
  deliveries: Delivery[];
  canReveal: boolean;
  nativeOff: NativeOff;
  onOpen: (path: string) => void;
  onReveal: (path: string) => void;
  onCopy: (path: string) => void;
  onRevert: (d: Delivery, a: Artifact) => void;
}

const check = (a: Artifact) => (a.validation ? (a.validation.ok ? '检查通过' : '检查没过') : a.self_checked ? '尝试自检' : '未检查');
const bar = (a: Artifact) => (a.validation ? (a.validation.ok ? 'var(--tk-mission)' : '#ff4145') : '#7a7a7a');
const verdict = (d: Delivery) => (d.state === 'accepted' ? `已接受${d.decided_at ? ` ${formatClock(d.decided_at)}` : ''}` : d.state === 'rejected' ? '已驳回' : '待复核');

interface MenuAt {
  x: number;
  y: number;
  a: Artifact;
}

export function Artifacts({ deliveries, canReveal, nativeOff, onOpen, onReveal, onCopy, onRevert }: ArtifactsProps) {
  const sorted = [...deliveries].sort((a, b) => a.version - b.version);
  const [shown, setShown] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [revert, setRevert] = useState<Artifact | null>(null);
  const d = sorted.find((x) => x.id === shown) ?? sorted.at(-1);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLElement>('button:not([aria-disabled])')?.focus();
    const close = (e: Event) => {
      if (e instanceof globalThis.KeyboardEvent && e.key !== 'Escape') return;
      if (e.type === 'keydown') e.preventDefault();
      if (e.type === 'mousedown' && menuRef.current?.contains(e.target as Node)) return;
      setMenu(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close, true);
    };
  }, [menu]);
  if (!d) return null;
  const open = d.artifacts.filter((a) => a.opened).length;
  const openOff = nativeOff.artifact;
  const at = (e: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, a: Artifact) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = 'clientX' in e && e.clientX ? e.clientX : r.left + r.width / 2;
    const y = 'clientY' in e && e.clientY ? e.clientY : r.bottom;
    setMenu({ x: Math.min(x, window.innerWidth - 220), y: Math.min(y, window.innerHeight - 200), a });
  };
  const item = (label: string, run: () => void, off?: string, danger?: boolean) => (
    <button type="button" role="menuitem" aria-disabled={off ? true : undefined} title={off} data-danger={danger || undefined} onClick={() => {
      if (off) return;
      setMenu(null);
      run();
    }}>
      {label}
    </button>
  );
  return (
    <>
      <div className={detail.sh}>
        产物<span className="num">{d.artifacts.length}</span>
        <span className={detail.r}>{d.verification_source === 'auto' ? '已自动检查' : '未验证'} │ 点开文件；右键{canReveal ? revealText('在 Finder 中显示') : ''}、复制路径</span>
      </div>
      <div className={styles.rw}>
        <Box className={styles.wm} />
        <div className={styles.lb}>
          <span className={styles.v}>v{d.version}</span>
          <small>
            看过 <span className="num">{open} / {d.artifacts.length}</span>
          </small>
          <Micro />
        </div>
        {d.redacted ? (
          <p className={detail.desc} data-dim="" role="status">
            这一版已撤回：标题、摘要和产物都不再显示
          </p>
        ) : (
          <div className={styles.files} role="group" aria-label="产物">
            {d.artifacts.map((a) => (
              <button
                key={a.absolute_path}
                type="button"
                className={styles.fc}
                data-off={openOff ? '' : undefined}
                title={openOff ? `${a.path} │ ${openOff}` : `${a.path} │ ${check(a)}`}
                onClick={() => !openOff && onOpen(a.absolute_path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  at(e, a);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
                    e.preventDefault();
                    at(e, a);
                  }
                }}
              >
                <span className={styles.tl} style={{ '--rar': bar(a) } as CSSProperties}>
                  <Icon name={/\.(csv|json)$/i.test(a.name) ? 'grid' : 'file'} size={32} />
                  <span className={styles.ext} aria-hidden="true">
                    {a.name.split('.').pop()}
                  </span>
                </span>
                {!a.opened && <span className={styles.seen} title="还没打开过" />}
                <b>{a.name}</b>
                <small>
                  {check(a)} │ v{a.version}
                </small>
              </button>
            ))}
          </div>
        )}
        {sorted.length > 1 && (
          <div className={styles.chain} role="group" aria-label="版本链">
            {sorted.map((x, i) => (
              <Fragment key={x.id}>
                {i > 0 && <span aria-hidden="true">→</span>}
                <button type="button" aria-pressed={x.id === d.id} onClick={() => setShown(x.id)}>
                  <span className="num">v{x.version}</span> {verdict(x)}
                </button>
              </Fragment>
            ))}
          </div>
        )}
      </div>
      {menu && (
        <div ref={menuRef} className={styles.cmenu} role="menu" aria-label={menu.a.name} style={{ left: menu.x, top: menu.y }}>
          <div className={styles.gt}>{menu.a.name}</div>
          {item('打开', () => onOpen(menu.a.absolute_path), openOff)}
          {canReveal && item(revealText('在 Finder 中显示'), () => onReveal(menu.a.absolute_path))}
          {item('复制路径', () => onCopy(menu.a.absolute_path), nativeOff.copy)}
          {menu.a.version > 1 && !d.redacted && item(`撤回到 v${menu.a.version - 1}`, () => setRevert(menu.a), undefined, true)}
        </div>
      )}
      <Modal
        open={revert != null}
        danger
        title={`把「${revert?.name ?? ''}」撤回到 v${(revert?.version ?? 2) - 1}？`}
        note={`把上一版写回去，成为 v${(revert?.version ?? 1) + 1}；v${revert?.version ?? ''} 留在版本里。`}
        confirmLabel="撤回"
        cancelLabel="算了"
        onCancel={() => setRevert(null)}
        onConfirm={() => {
          if (revert) onRevert(d, revert);
          setRevert(null);
        }}
      />
    </>
  );
}
