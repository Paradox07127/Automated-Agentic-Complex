// 产物 (RewardsNode): the shown version and its verdict, how many were opened, a tile per file with its check bar, the
// version chain folded below; a file's right-click menu opens, reveals, copies its path or writes the previous version back.
import { useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { revealText } from '../../bridge/platformText';
import { formatClock, type Artifact, type Delivery } from '../../domain';
import { ContextMenu, Fold, Icon, InfoTip, Modal, SecHead, type MenuItem } from '../../ui';
import { GameSeg } from '../../ui/game';
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
const bar = (a: Artifact) => (a.validation ? (a.validation.ok ? 'var(--ef-mission-accent)' : 'var(--ef-danger-vivid)') : 'var(--ef-g-lock)');
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
  if (!d) return null;
  const open = d.artifacts.filter((a) => a.opened).length;
  const openOff = nativeOff.artifact;
  const at = (e: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, a: Artifact) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = 'clientX' in e && e.clientX ? e.clientX : r.left + r.width / 2;
    const y = 'clientY' in e && e.clientY ? e.clientY : r.bottom;
    setMenu({ x, y, a });
  };
  const items = (a: Artifact): MenuItem[] => [
    { kind: 'head', label: a.name },
    { kind: 'item', label: '打开', disabled: !!openOff, reason: openOff, onSelect: () => onOpen(a.absolute_path) },
    ...(canReveal ? [{ kind: 'item' as const, label: revealText('在 Finder 中显示'), onSelect: () => onReveal(a.absolute_path) }] : []),
    { kind: 'item', label: '复制路径', disabled: !!nativeOff.copy, reason: nativeOff.copy, onSelect: () => onCopy(a.absolute_path) },
    ...(a.version > 1 && !d.redacted ? [{ kind: 'item' as const, label: `撤回到 v${a.version - 1}`, danger: true, onSelect: () => setRevert(a) }] : []),
  ];
  return (
    <>
      <SecHead
        title="产物"
        count={d.artifacts.length}
        right={<InfoTip>{`${d.verification_source === 'auto' ? '已自动检查' : '未验证'}。点开文件；右键${canReveal ? `${revealText('在 Finder 中显示')}、` : ''}复制路径。`}</InfoTip>}
      />
      <div className={styles.rw}>
        <Box className={styles.wm} />
        <div className={styles.lb}>
          <span className={styles.v}>v{d.version}</span>
          <small>{verdict(d)}</small>
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
                title={openOff ? `${a.path} │ ${openOff}` : `${a.path} │ ${check(a)} │ v${a.version}`}
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
                <small>{check(a)}</small>
              </button>
            ))}
          </div>
        )}
      </div>
      {sorted.length > 1 && (
        <Fold id="versions" label="版本" count={sorted.length} summary={`v${sorted[0]?.version} → v${sorted.at(-1)?.version}`}>
          <GameSeg label="版本链" value={d.id} options={sorted.map((x) => ({ value: x.id, label: `v${x.version} ${verdict(x)}` }))} onChange={setShown} />
        </Fold>
      )}
      <ContextMenu label={menu?.a.name ?? ''} items={menu ? items(menu.a) : []} at={menu} onClose={() => setMenu(null)} />
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
