import type { Demo } from '../../shell/types';

// Every state below must open by URL and look right.
// Every block on this page reads an existing interface, so there is no `full` demo.
export const demos: Demo[] = [
  { name: 'default', params: {} },
  { name: 'light', params: { theme: 'light' } }, // 亮色主题
  { name: 'speak-light', params: { group: 'speak', theme: 'light' } },
  { name: 'agentdoff', params: { demo: 'agentdoff' } }, // 后台未连接：依赖 agentd 的组只读
  { name: 'configerr', params: { demo: 'configerr' } }, // config.json 读取失败 [打开配置文件]
  { name: 'speak', params: { group: 'speak' } },
  { name: 'keys', params: { group: 'keys' } },
  { name: 'kernel', params: { group: 'kernel' } },
  { name: 'model', params: { group: 'model' } },
  { name: 'privacy', params: { group: 'privacy' } },
  { name: 'perm', params: { group: 'perm' } },
  { name: 'data', params: { group: 'data' } },
  { name: 'about', params: { group: 'about' } },
  { name: 'dropdown-open', params: { group: 'speak', demo: 'dropdown-open', item: 'replyLang' } }, // 下拉展开
  { name: 'confirm-danger', params: { group: 'privacy', demo: 'confirm-danger', item: 'wintext' } }, // 关闭并删除 214 条
  { name: 'confirm-wipe', params: { group: 'data', demo: 'confirm-wipe' } }, // 删除所有本地数据：白纸确认卡
  { name: 'pending', params: { group: 'privacy', demo: 'pending' } }, // ⟳ 待应用
  { name: 'kernel-logged-out', params: { group: 'kernel', demo: 'logged-out' } }, // 未登录：恢复命令 + 改用 Claude Code
  { name: 'perm-fix', params: { group: 'perm', item: 'automation' } }, // 修复路径落点
  { name: 'search', params: { demo: 'search', q: '截图' } }, // 设置搜索
  { name: 'search-empty', params: { demo: 'search', q: '天气' } }, // 搜索无结果：写下一步
  { name: 'loading', params: { state: 'loading' } },
  { name: 'error', params: { state: 'error' } },
  { name: 'agentdoff-kernel', params: { group: 'kernel', demo: 'agentdoff' } }, // 依赖 agentd 的组只读
  { name: 'kernel-draft', params: { group: 'kernel', demo: 'draft' } }, // 整组草稿：未应用 2 项 + 草稿三角
  { name: 'light-kernel', params: { group: 'kernel', theme: 'light' } },
  { name: 'model-chatgpt', params: { group: 'model', demo: 'chatgpt' } }, // ChatGPT 多账号：使用 / 重新连接 / 退出
  { name: 'model-chatgpt-light', params: { group: 'model', demo: 'chatgpt', theme: 'light' } },
  { name: 'kernel-no-key', params: { group: 'kernel', demo: 'no-key' } }, // 未就绪原因 + 去填写 API Key
  { name: 'kernel-no-key-light', params: { group: 'kernel', demo: 'no-key', theme: 'light' } },
  { name: 'hooks-off', params: { group: 'privacy', demo: 'hooks-off', item: 'hooks2' } }, // 编码工具未接入：安装步骤
  { name: 'hooks-off-light', params: { group: 'privacy', demo: 'hooks-off', item: 'hooks2', theme: 'light' } },
  { name: 'perm-light', params: { group: 'perm', theme: 'light' } }, // 输入监控行 + 允许
  { name: 'privacy-agentdoff', params: { group: 'privacy', demo: 'agentdoff', item: 'mask' } }, // agentd 断开：依赖它的行只读
  { name: 'privacy-agentdoff-light', params: { group: 'privacy', demo: 'agentdoff', item: 'mask', theme: 'light' } },
];
