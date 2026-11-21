import { useState } from 'react';
import type { Artifact } from '../../domain';
import { Menu, Table, TableCell, TableHead, TableRow, type MenuItem } from '../../ui';
import type { NativeOff } from './actions';
import styles from './TaskView.module.css';

export interface ArtifactTableProps {
  artifacts: Artifact[];
  /** Bridge has `revealInFinder`. */
  canReveal?: boolean;
  onOpen?: (path: string) => void;
  onReveal?: (path: string) => void;
  onCopyPath?: (path: string) => void;
  /** Entries the shell refused, with the reason. */
  nativeOff?: NativeOff;
}

// Room for every row, so the header sticks inside the table rather than to the detail pane.
const ROW_H = 40;

/** Artifacts as a table: ↑↓ select, ↵ or a click on the name opens, the rest sits in the row-end ⋯. Actions get the absolute path. */
export function ArtifactTable({ artifacts, canReveal, onOpen, onReveal, onCopyPath, nativeOff = {} }: ArtifactTableProps) {
  const [sel, setSel] = useState<string | null>(null);
  const openOff = nativeOff.artifact;
  const menu = (path: string): MenuItem[] => [
    { kind: 'item', label: '打开', hint: '⏎', disabled: openOff != null, reason: openOff, onSelect: () => onOpen?.(path) },
    ...(canReveal ? [{ kind: 'item' as const, label: '在 Finder 中显示', onSelect: () => onReveal?.(path) }] : []),
    { kind: 'item', label: '复制路径', disabled: nativeOff.copy != null, reason: nativeOff.copy, onSelect: () => onCopyPath?.(path) },
  ];
  return (
    <Table
      label="产物"
      selected={sel}
      onSelect={setSel}
      onOpen={openOff ? undefined : (path) => onOpen?.(path)}
      maxHeight={(artifacts.length + 1) * ROW_H}
      head={
        <TableHead menu>
          <TableCell head>名称</TableCell>
          <TableCell head num>
            版本
          </TableCell>
          <TableCell head>看过</TableCell>
          <TableCell head>检查</TableCell>
        </TableHead>
      }
    >
      {artifacts.map((a) => (
        <TableRow key={a.absolute_path} id={a.absolute_path} menu={<Menu label={`更多操作：${a.name}`} icon="more" items={menu(a.absolute_path)} align="right" />}>
          <TableCell>
            {openOff ? (
              <span title={`${a.path} │ ${openOff}`}>{a.name}</span>
            ) : (
              <button type="button" tabIndex={-1} className={styles.link} title={a.path} onClick={() => onOpen?.(a.absolute_path)}>
                {a.name}
              </button>
            )}
          </TableCell>
          <TableCell num>{a.version}</TableCell>
          <TableCell>{a.opened ? '看过' : '未看'}</TableCell>
          <TableCell>{a.validation ? a.validation.ok ? '检查通过' : '检查失败' : a.self_checked ? '尝试自检' : '未检查'}</TableCell>
        </TableRow>
      ))}
    </Table>
  );
}
