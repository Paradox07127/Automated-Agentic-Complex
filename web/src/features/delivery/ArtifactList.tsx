import type { KeyboardEvent, MouseEvent } from 'react';
import type { Artifact } from '../../domain';
import { Icon, Menu, type MenuItem } from '../../ui';
import styles from './ArtifactList.module.css';
import { ArtifactChecks } from './ArtifactChecks';

/** 产物表：一行一个产物，⏎ 或点行打开；在 Finder 中显示（按能力位）、复制路径收进行尾 ⋯。 */
export interface ArtifactListProps {
  /** 产物 */
  artifacts: Artifact[];
  /** 交付框 / 抽屉，抽屉里行更紧，默认 chips */
  layout?: 'chips' | 'rows';
  /** 桥有 revealInFinder 能力位时显示「在 Finder 中显示」 */
  canReveal?: boolean;
  /** 打开，传绝对路径（bridge.open.artifact 只认绝对路径） */
  onOpen?: (path: string) => void;
  /** 在 Finder 中显示 */
  onReveal?: (path: string) => void;
  /** 复制路径 */
  onCopyPath?: (path: string) => void;
}

const isTable = (name: string) => /\.(csv|xlsx|numbers)$/i.test(name);

export function ArtifactList({ artifacts, layout = 'chips', canReveal, onOpen, onReveal, onCopyPath }: ArtifactListProps) {
  const opened = artifacts.filter((a) => a.opened).length;
  // ⏎ opens the focused row, ↑↓ move between rows; keys from the ⋯ menu stay with the menu.
  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, path: string) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      onOpen?.(path);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling;
      (next as HTMLElement | null)?.focus();
    }
  };
  // The ⋯ list is portalled out of the row, so a click on its items reaches the row through React only.
  const onRowClick = (e: MouseEvent<HTMLTableRowElement>, path: string) => {
    if (e.currentTarget.contains(e.target as Node) && !(e.target as HTMLElement).closest('[data-stub="Menu"]')) onOpen?.(path);
  };
  const menu = (a: Artifact): MenuItem[] => [
    { kind: 'item', label: '打开', hint: '⏎', onSelect: () => onOpen?.(a.absolute_path) },
    ...(canReveal ? [{ kind: 'item' as const, label: '在 Finder 中显示', onSelect: () => onReveal?.(a.absolute_path) }] : []),
    { kind: 'item', label: '复制路径', onSelect: () => onCopyPath?.(a.absolute_path) },
  ];
  return (
    <div data-stub="ArtifactList" data-layout={layout} className={styles.root}>
      <p className={styles.count} data-unopened={opened < artifacts.length || undefined}>
        产物 <span className="num">{opened}</span>/<span className="num">{artifacts.length}</span> 打开过
      </p>
      <table className={styles.table} aria-label="产物，回车打开">
        <colgroup>
          <col />
          <col className={styles.colSeen} />
          <col className={styles.colMore} />
        </colgroup>
        <thead className={styles.head}>
          <tr>
            {['名称', '看过', '操作'].map((h) => (
              <th key={h} scope="col">
                <span className={styles.vh}>{h}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {artifacts.map((a) => (
            <tr key={a.path} tabIndex={0} title={a.path} data-self-checked={a.self_checked || undefined} onKeyDown={(e) => onRowKey(e, a.absolute_path)} onClick={(e) => onRowClick(e, a.absolute_path)}>
              <td>
                <span className={styles.name}>
                  <span className={styles.icon} aria-hidden="true">
                    <Icon name={isTable(a.name) ? 'grid' : 'file'} size={14} />
                  </span>
                  <span className={styles.text}>{a.name}</span>
                </span>
              </td>
              <td className={styles.seen}>{a.opened ? '看过' : ''}</td>
              <td className={styles.more}>
                <Menu label={`更多操作：${a.name}`} icon="more" items={menu(a)} align="right" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ArtifactChecks artifacts={artifacts} />
    </div>
  );
}
