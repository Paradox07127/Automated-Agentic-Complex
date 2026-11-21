import { createContext, useContext, useLayoutEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface HeaderSlotValue {
  setSub: (sub: string | null) => void;
  /** The page header's tabs container, right after the title. */
  tabs?: HTMLElement | null;
  /** The page header's status container. */
  right: HTMLElement | null;
  /** The page header's primary-action container, right of the status. */
  action: HTMLElement | null;
  /** The bottom action bar container along the bottom of `<main>`. */
  bottom?: HTMLElement | null;
}

export const HeaderSlotContext = createContext<HeaderSlotValue | null>(null);

export interface PageHeaderSlotProps {
  /** Second breadcrumb: `设置 / 隐私`. */
  sub?: string;
  /** Page tabs right after the title. */
  tabs?: ReactNode;
  /** Status readouts at the header's right end. */
  right?: ReactNode;
  /** The page's one primary button, at the far right. */
  action?: ReactNode;
  /** Bottom action bar content along the bottom of `<main>`. */
  bottom?: ReactNode;
}

function Portal({ node, into, inShell }: { node: ReactNode; into: HTMLElement | null; inShell: boolean }) {
  if (!node) return null;
  if (!inShell) return <>{node}</>;
  return into ? createPortal(node, into) : null;
}

/** Lets a page fill the shell's PageHeader and bottom action bar; outside the shell (unit tests) slots render in place. */
export function PageHeaderSlot({ sub, tabs, right, action, bottom }: PageHeaderSlotProps) {
  const slot = useContext(HeaderSlotContext);
  const setSub = slot?.setSub;
  useLayoutEffect(() => {
    if (!setSub) return;
    setSub(sub ?? null);
    return () => setSub(null);
  }, [setSub, sub]);
  return (
    <>
      <Portal node={tabs} into={slot?.tabs ?? null} inShell={!!slot} />
      <Portal node={right} into={slot?.right ?? null} inShell={!!slot} />
      <Portal node={action} into={slot?.action ?? null} inShell={!!slot} />
      <Portal node={bottom} into={slot?.bottom ?? null} inShell={!!slot} />
    </>
  );
}

/** Lets a page fill the shell's 44px dark bottom action bar along the bottom of `<main>`. */
export function BottomBarSlot({ children }: { children?: ReactNode }) {
  const slot = useContext(HeaderSlotContext);
  return <Portal node={children} into={slot?.bottom ?? null} inShell={!!slot} />;
}
