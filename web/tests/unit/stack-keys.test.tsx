import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCard, QuestionBox } from '../../src/features/approval';
import { APPROVALS, NOW, pick, QUESTIONS } from '../../src/mock/fixtures';
import { stackScenario } from '../../src/mock/stack';
import { keyActionFor } from '../../src/surfaces/stack/keys';
import { orderCards } from '../../src/surfaces/stack/model';
import { stubMatchMedia } from './mediaStub';
import { A1, A2, Q1 } from '../../src/mock/fixtures/ids';

stubMatchMedia();
// The stack page runs on the stack surface; getBridge() builds its fake for the surface named here.
document.documentElement.dataset.surface = 'stack';
afterEach(cleanup);

describe('stack keys', () => {
  const ordered = orderCards(stackScenario('default').cards);
  const danger = ordered[0];
  const plain = ordered.find((c) => c.id === A2);

  it('never approves a dangerous card from ⏎, but esc still denies it', () => {
    expect(keyActionFor(danger, 'Enter')).toEqual({ type: 'danger-hint', id: A1 });
    expect(keyActionFor(danger, 'Escape')).toEqual({ type: 'decide', id: A1, decision: 'deny', generation: pick(APPROVALS, A1).generation });
  });

  it('approves a normal card from ⏎', () => {
    expect(keyActionFor(plain, 'Enter')).toEqual({ type: 'decide', id: A2, decision: 'allow', generation: pick(APPROVALS, A2).generation });
  });
});

describe('shared approval and question cards', () => {
  it('shows the mouse-only hint on ⏎ for a dangerous card and denies on esc', () => {
    const onDecide = vi.fn();
    render(<ApprovalCard approval={pick(APPROVALS, A1)} onDecide={onDecide} />);
    const card = screen.getByLabelText(/^审批：/);
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/只能用鼠标点击/);
    fireEvent.keyDown(card, { key: 'Escape' });
    expect(onDecide).toHaveBeenCalledWith('deny');
  });

  it('submits free text without picking an option and shows 不限时', () => {
    const onAnswer = vi.fn();
    render(<QuestionBox question={pick(QUESTIONS, Q1)} now={NOW} compact onAnswer={onAnswer} />);
    expect(screen.getByText(/不限时/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('写下回答'), { target: { value: '单列，但放最后' } });
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
    expect(Object.values(onAnswer.mock.calls[0]![0])).toEqual([['单列，但放最后']]);
  });
});
