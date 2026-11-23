import { APPROVALS, NOW, pick } from '../../mock/fixtures';
import { A1, A2, A3 } from '../../mock/fixtures/ids';
import type { ApprovalCardProps } from './ApprovalCard';

export const ApprovalCardDemos: Array<{ name: string; props: ApprovalCardProps }> = [
  { name: 'normal', props: { approval: pick(APPROVALS, A2), position: { index: 2, total: 3 }, previewOpen: true } },
  { name: 'danger', props: { approval: pick(APPROVALS, A1), surface: 'desk', queue: { more: 2, dangerous: 0 }, timelineReason: '后台暂不提供' } },
  { name: 'danger-fold', props: { approval: pick(APPROVALS, A1), details: 'fold', timelineReason: '后台暂不提供' } },
  { name: 'approved', props: { approval: pick(APPROVALS, A3), outcome: { kind: 'approved', at: NOW } } },
  { name: 'urgent', props: { approval: { ...pick(APPROVALS, A3), seconds_left: 8 }, surface: 'desk', position: { index: 1, total: 3 } } },
  { name: 'expired', props: { approval: { ...pick(APPROVALS, A3), seconds_left: 0 } } },
  {
    name: 'long-cmd',
    props: {
      approval: {
        ...pick(APPROVALS, A3),
        cmd: 'swift test --filter HostLinkTests --parallel --num-workers 4 --skip-build -Xswiftc -warnings-as-errors --enable-code-coverage && xcrun llvm-cov report .build/debug/CompanionPackageTests.xctest/Contents/MacOS/CompanionPackageTests -instr-profile .build/debug/codecov/default.profdata',
      },
      surface: 'desk',
    },
  },
  { name: 'elsewhere', props: { approval: pick(APPROVALS, A2), outcome: { kind: 'elsewhere', at: NOW - 40_000 } } },
  { name: 'failed', props: { approval: pick(APPROVALS, A3), outcome: { kind: 'failed', at: NOW, text: '后台服务没有响应，决定没送到' } } },
];
