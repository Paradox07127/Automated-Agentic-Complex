import { useState } from 'react';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromDelivery, fromTaskRow, effectiveState } from '../../src/domain';
import { WIRE_DELIVERIES, WIRE_TASK_ROWS } from '../../src/mock/fixtures/wire/work';
import { WIRE_RUNTIME } from '../../src/mock/fixtures/wire/system';
import { runtimeBody } from '../../src/pages/settings/fields';
import { deriveView, emptyLocal } from '../../src/pages/tasks/model';
import { TaskDrawer } from '../../src/features/task/TaskDrawer';
import { catOf, plateOf } from '../../src/pages/memory/model';
import { useDeliveryVisibility } from '../../src/features/delivery';
import { useReceipts } from '../../src/pages/tasks/live';
import { sendReceipt } from '../../src/pages/tasks/deliveryCalls';
import { useMotions } from '../../src/pages/character/useMotions';
import { createFakeBridge } from '../../src/bridge/fake';

vi.mock('../../src/pages/tasks/deliveryCalls', async (original) => ({ ...await original<object>(), sendReceipt: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); delete window.agenticComplex; });

const wire = { ...WIRE_DELIVERIES[0]!, delivery_version: 1, generation: 42, revision: 1,
  state: 'produced' as const, decided_at: null, presented_at: null, viewed_at: null, outcome: 'failed',
  artifacts: [{ ...WIRE_DELIVERIES[0]!.artifacts[0]!, self_checked: true,
    validation: { ok: false, checks: [{ check: 'calculation', ok: false, column: 'net' }] } }] };
const delivery = fromDelivery(wire);

describe('product review regressions', () => {
  it('changes scope, limits, tools and retention without returning a saved executable; a new selection still sends its handle', () => {
    const current = { ...WIRE_RUNTIME, executable: '/opt/bin/codex' };
    expect(runtimeBody(current,{ scope:'scope-new', maxCost:2, archive:'7d' }))
      .toEqual({ scope_id:'scope-new',max_budget_usd:2,history_retention:'7d' });
    const handle = { handle:'fresh-picker-handle', displayName:'codex' };
    expect(runtimeBody(current,{ exe:'codex' },{ exe:handle })).toEqual({ executable:handle });
  });

  it('shows failed checks and repair, without creating a review or claiming the first delivery is v43', () => {
    const task = fromTaskRow({ ...WIRE_TASK_ROWS[0]!, canonical_task_id:wire.canonical_task_id, state:'failed', delivery:wire, run_id:wire.run_id });
    const view = deriveView({ tasks:[task],deliveries:[delivery],sessions:[],approvals:[],questions:[],goals:[],activeRuns:{},roleMissing:false,offline:false },emptyLocal());
    expect(view.pending).toEqual([]);
    expect(effectiveState(task,{pending:[{ task_id:task.id }]})).toBe('failed');
    expect(delivery.version).toBe(1);
    render(<TaskDrawer task={task} effective="failed" now={Date.now()} delivery={delivery} />);
    expect(screen.queryByRole('button',{name:'接受这一版'})).toBeNull();
    expect(screen.getByLabelText('产物检查失败').textContent).toContain('计算结果不符（net）');
    expect(screen.queryByText('已在运行 · 还没有计划')).toBeNull();
    expect(screen.queryByText('✓ 这一版已退回')).toBeNull();
  });

  it('keeps project facts outside personal profile without discarding their evidence', () => {
    expect(catOf({kind:'fact',text:'测试：通过'})).toBe('other');
    expect(catOf({kind:'fact',text:'时区：上海'})).toBe('about');
    expect(catOf({kind:'experience',text:'改过 HostLink 后断线'})).toBe('exp');
    expect(plateOf([])).toEqual({ name: null, birthday: null, place: null, about: 0 });
  });

  it('shows a hidden character before asking its host to play and does not claim play if showing fails', async () => {
    const bridge = createFakeBridge({surface:'main',still:true}); window.agenticComplex=bridge;
    const original=await bridge.avatar.state(); let visible=false;
    vi.spyOn(bridge.avatar,'state').mockImplementation(async()=>({...original,visible}));
    const show=vi.spyOn(bridge.avatar,'setVisible').mockImplementation(async(v)=>{ visible=v; });
    const play=vi.spyOn(bridge.avatar,'playAction').mockResolvedValue();
    const toast=vi.fn(); const {result}=renderHook(()=>useMotions({actions:[],toast}));
    const motion=(await bridge.avatar.actions())[0]!;
    await act(()=>result.current.preview(motion,1));
    expect(show).toHaveBeenCalledWith(true); expect(play).toHaveBeenCalledWith(motion.id,1);
    visible=false; show.mockResolvedValue(); play.mockClear();
    await act(()=>result.current.preview(motion,1));
    expect(play).not.toHaveBeenCalled(); expect(toast.mock.calls.at(-1)?.[0]).toContain('角色仍然隐藏');
  });

  it('records presentation and viewing only when visible, serializes revisions and deduplicates remount callbacks', async () => {
    let notify: IntersectionObserverCallback=()=>{}; let target: Element;
    vi.stubGlobal('IntersectionObserver',class { constructor(cb:IntersectionObserverCallback){ notify=cb; }
      observe(el:Element){ target=el; } disconnect(){} });
    const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');
    vi.mocked(sendReceipt).mockImplementation(async(d,kind)=>({...d,revision:d.revision+1,
      ...(kind==='presented'?{presented_at:10}:{viewed_at:20})}));
    function Fixture(){ const [d,setD]=useState(delivery); const receipt=useReceipts([d],setD,()=>{});
      const ref=useDeliveryVisibility(d,receipt,'viewed'); return <div ref={ref}>delivery</div>; }
    render(<Fixture/>);
    const intersect=(ratio:number)=>notify([{target,isIntersecting:ratio>0,intersectionRatio:ratio} as IntersectionObserverEntry],{} as IntersectionObserver);
    await act(async()=>intersect(0)); expect(sendReceipt).not.toHaveBeenCalled();
    await act(async()=>intersect(.5)); expect(sendReceipt).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    await act(async()=>document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(()=>expect(sendReceipt).toHaveBeenCalledTimes(2));
    expect(vi.mocked(sendReceipt).mock.calls.map(([d,k])=>[d.revision,k])).toEqual([[1,'presented'],[2,'viewed']]);
    await act(async()=>intersect(1)); expect(sendReceipt).toHaveBeenCalledTimes(2);
  });

  it('fills the missing presentation of a legacy viewed delivery without altering its viewing or decision', async () => {
    const legacy = { ...delivery, viewed_at: 1234, revision: 8, state: 'viewed' as const };
    vi.mocked(sendReceipt).mockImplementation(async(d)=>({...d,presented_at:2345,revision:d.revision+1}));
    const onDelivery = vi.fn();
    const {result} = renderHook(()=>useReceipts([legacy],onDelivery,()=>{}));
    await act(async()=>result.current(legacy.id,'viewed'));
    await waitFor(()=>expect(sendReceipt).toHaveBeenCalledTimes(1));
    expect(vi.mocked(sendReceipt).mock.calls[0]?.[1]).toBe('presented');
    expect(onDelivery.mock.calls[0]?.[0]).toMatchObject({viewed_at:1234,state:'viewed',decided_at:null});
  });

  it('ends the finite preview indicator after the motion duration', async () => {
    vi.useFakeTimers();
    const bridge = createFakeBridge({surface:'main',still:true}); window.agenticComplex=bridge;
    const motion = { ...(await bridge.avatar.actions())[0]!, durationS:.1 };
    vi.spyOn(bridge.avatar,'playAction').mockResolvedValue();
    const {result}=renderHook(()=>useMotions({actions:[motion],toast:vi.fn()}));
    await act(()=>result.current.preview(motion,1));
    expect(result.current.play?.id).toBe(motion.id);
    await act(async()=>vi.advanceTimersByTime(200));
    expect(result.current.play).toBeNull();
  });
});
