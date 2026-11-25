import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '../../src/ui/Dialog';
import { InfoTip } from '../../src/ui/InfoTip';
import { Sheet } from '../../src/ui/Sheet';

afterEach(cleanup);

type Overlay = 'dialog' | 'sheet';

function Harness({ kind, onClose }: { kind: Overlay; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const close = () => {
    onClose?.();
    setOpen(false);
  };
  const body = (
    <>
      <input aria-label="名称" />
      <button type="button">选项</button>
    </>
  );
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开
      </button>
      {kind === 'dialog' ? (
        <Dialog open={open} title="交派任务" onClose={close} footer={<button type="button">交派</button>}>
          {body}
        </Dialog>
      ) : (
        <Sheet open={open} title="任务详情" onClose={close}>
          {body}
        </Sheet>
      )}
    </>
  );
}

function openFrom() {
  const trigger = screen.getByRole('button', { name: '打开' });
  trigger.focus();
  fireEvent.click(trigger);
  return { trigger, dialog: screen.getByRole('dialog') };
}

for (const kind of ['dialog', 'sheet'] as const) {
  describe(kind === 'dialog' ? 'Dialog' : 'Sheet', () => {
    it('is a labelled modal dialog and starts on the first body control, not the close button', () => {
      render(<Harness kind={kind} />);
      const { dialog } = openFrom();
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
      expect(document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(kind === 'dialog' ? '交派任务' : '任务详情');
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '名称' }));
    });

    it('keeps Tab and Shift+Tab inside', () => {
      render(<Harness kind={kind} />);
      const { dialog } = openFrom();
      const inside = Array.from(dialog.querySelectorAll<HTMLElement>('button, input'));
      const last = inside.at(-1);
      const first = inside[0];
      last?.focus();
      fireEvent.keyDown(last as HTMLElement, { key: 'Tab' });
      expect(document.activeElement).toBe(first);
      fireEvent.keyDown(first as HTMLElement, { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(last);
      for (let i = 0; i < inside.length * 2; i++) {
        fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab' });
        expect(dialog.contains(document.activeElement)).toBe(true);
      }
    });

    it('closes on Esc and gives focus back to the trigger', () => {
      const onClose = vi.fn();
      render(<Harness kind={kind} onClose={onClose} />);
      const { trigger } = openFrom();
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });

    it('closes from the close button and on a scrim press, not on a press inside', () => {
      const onClose = vi.fn();
      render(<Harness kind={kind} onClose={onClose} />);
      const { dialog } = openFrom();
      fireEvent.mouseDown(dialog);
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.mouseDown(dialog.parentElement as HTMLElement);
      expect(onClose).toHaveBeenCalledTimes(1);
      openFrom();
      fireEvent.click(screen.getByRole('button', { name: '关闭' }));
      expect(onClose).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
}

describe('Dialog initial focus', () => {
  it('skips an InfoTip and starts on the first field, with the tip closed', () => {
    render(
      <Dialog open title="设置">
        <InfoTip>说明</InfoTip>
        <input aria-label="名称" />
      </Dialog>,
    );
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '名称' }));
    expect(screen.getByRole('tooltip', { hidden: true }).hidden).toBe(true);
  });

  it('falls back to the panel when the body has only an InfoTip', () => {
    render(
      <Dialog open title="设置">
        <InfoTip>说明</InfoTip>
      </Dialog>,
    );
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });
});

describe('Dialog opened inside a Sheet', () => {
  function Stacked() {
    const [sheet, setSheet] = useState(true);
    const [dialog, setDialog] = useState(false);
    return (
      <Sheet open={sheet} title="任务详情" onClose={() => setSheet(false)}>
        <button type="button" onClick={() => setDialog(true)}>
          停止
        </button>
        <Dialog open={dialog} title="确认停止" onClose={() => setDialog(false)} footer={<button type="button">停止任务</button>}>
          <input aria-label="原因" />
        </Dialog>
      </Sheet>
    );
  }

  const mountRoot = () => {
    const root = document.createElement('div');
    root.id = 'ef-modal-root';
    document.body.appendChild(root);
    return root;
  };

  it('keeps Tab inside the Dialog and Esc closes only the top layer', () => {
    const root = mountRoot();
    try {
      render(<Stacked />);
      fireEvent.click(screen.getByRole('button', { name: '停止' }));
      const dialog = screen.getByRole('dialog', { name: '确认停止' });
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '原因' }));
      for (let i = 0; i < 6; i++) {
        fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab' });
        expect(dialog.contains(document.activeElement)).toBe(true);
      }
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
      expect(screen.queryByRole('dialog', { name: '确认停止' })).toBeNull();
      expect(screen.getByRole('dialog', { name: '任务详情' })).toBeTruthy();
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      cleanup();
      root.remove();
    }
  });
});

describe('Sheet', () => {
  it('is 360 wide by default and 480 when asked', () => {
    const { rerender } = render(<Sheet open title="详情" />);
    expect(screen.getByRole('dialog').dataset.width).toBe('360');
    rerender(<Sheet open title="详情" width={480} />);
    expect(screen.getByRole('dialog').dataset.width).toBe('480');
  });
});

describe('InfoTip', () => {
  it('shows its text while the ⓘ has focus and describes the ⓘ with it', () => {
    render(<InfoTip>只统计后台记下的轮次。</InfoTip>);
    const btn = screen.getByRole('button', { name: '说明' });
    // Open, the tip moves to <body>; read it by id each time.
    const tip = () => document.getElementById(btn.getAttribute('aria-describedby') ?? '');
    expect(tip()?.getAttribute('role')).toBe('tooltip');
    expect(tip()?.textContent).toBe('只统计后台记下的轮次。');
    expect(tip()?.hidden).toBe(true);
    fireEvent.focus(btn);
    expect(tip()?.hidden).toBe(false);
    expect(tip()?.parentElement).toBe(document.body);
    fireEvent.blur(btn);
    expect(tip()?.hidden).toBe(true);
  });

  it('shows on hover and closes on Esc without closing the dialog around it', () => {
    const onClose = vi.fn();
    render(
      <Dialog open title="设置" onClose={onClose}>
        <InfoTip>说明</InfoTip>
      </Dialog>,
    );
    const btn = screen.getByRole('button', { name: '说明' });
    const tip = () => screen.getByRole('tooltip', { hidden: true });
    fireEvent.mouseEnter(btn.parentElement as HTMLElement);
    expect(tip().hidden).toBe(false);
    fireEvent.mouseLeave(btn.parentElement as HTMLElement);
    expect(tip().hidden).toBe(true);
    fireEvent.focus(btn);
    expect(tip().hidden).toBe(false);
    fireEvent.keyDown(btn, { key: 'Escape' });
    expect(tip().hidden).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(btn, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Esc after a hover while focus is elsewhere in the dialog', () => {
    const onClose = vi.fn();
    render(
      <Dialog open title="设置" onClose={onClose}>
        <input aria-label="名称" />
        <InfoTip>说明</InfoTip>
      </Dialog>,
    );
    const input = screen.getByRole('textbox', { name: '名称' });
    const tip = () => screen.getByRole('tooltip', { hidden: true });
    fireEvent.mouseEnter(screen.getByRole('button', { name: '说明' }).parentElement as HTMLElement);
    expect(tip().hidden).toBe(false);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(tip().hidden).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('follows the ⓘ on scroll and resize and flips above it near the bottom edge', () => {
    let btnRect = { top: 80, bottom: 100, left: 40 };
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const r = this.getAttribute('role') === 'tooltip' ? { top: 0, bottom: 40, left: 0 } : btnRect;
      return { ...r, right: r.left + 20, x: r.left, y: r.top, width: 20, height: r.bottom - r.top, toJSON: () => r } as DOMRect;
    });
    try {
      render(<InfoTip defaultOpen>说明</InfoTip>);
      const tip = screen.getByRole('tooltip');
      expect(tip.style.top).toBe('104px');
      btnRect = { top: 300, bottom: 320, left: 40 };
      fireEvent.scroll(window);
      expect(tip.style.top).toBe('324px');
      btnRect = { top: window.innerHeight - 30, bottom: window.innerHeight - 10, left: 40 };
      fireEvent(window, new Event('resize'));
      expect(tip.style.top).toBe(`${window.innerHeight - 30 - 4 - 40}px`);
    } finally {
      spy.mockRestore();
    }
  });
});
