// The menu a right-click on the character pops up; restart and quit stay
// in the tray menu.
import { MENU_ROUTES, type MenuState, menuAccelerator } from '../../common/menus.ts';
import { appearanceItem, characterEntries, clickThroughItem, freeRoamItem, hiddenItem, item, label, type MenuItem,
  type MenuPorts, page, quietItem, SEPARATOR, submenu } from './items.ts';

export function avatarMenu(s: MenuState, ports: MenuPorts): MenuItem[] {
  const name = s.characters.find((c) => c.id === s.currentCharacter)?.name ?? '角色';
  // The avatar process's row from `services` when no toggle says more.
  const status = s.characterSwitching ? '切换中' : s.avatarHidden ? '已隐藏' : s.quiet ? '安静中'
    : s.services.find((r) => r.name === '角色')?.detail ?? '待命';
  const roles = characterEntries(s, ports);
  for (const extra of [appearanceItem(s, ports), layersItem(s, ports), mmdItem(s, ports)]) if (extra) roles.push(extra);
  const more: MenuItem[] = [item('pending', '待处理', page(ports, MENU_ROUTES.pending)), item('tune', '镜头与动作…', ports.openTune)];
  if (s.cameraFree) more.push(item('camera', '调整镜头…', ports.beginCamera));
  const capture = ports.capture;
  more.push(item('photoMode', '拍照模式…', page(ports, MENU_ROUTES.photo)),
    item('capture', '保存截图', capture && (() => {
      capture.take().then((file) => capture.saved(file), (e: unknown) => ports.log(`capture failed: ${e instanceof Error ? e.message : String(e)}`));
    }), { enabled: s.canCapture }));
  const freeRoam = freeRoamItem(s, ports);
  if (freeRoam) more.push(freeRoam);
  more.push(item('resetPosition', '放回默认位置', ports.resetPosition), item('resetPanels', '复位浮窗', ports.resetPanels));
  const clickThrough = clickThroughItem(s, ports);
  if (clickThrough) more.push(clickThrough);
  more.push(SEPARATOR, submenu('open', '打开', [
    item('open.home', '主页', page(ports, MENU_ROUTES.home)), item('open.memory', '记忆', page(ports, MENU_ROUTES.memory)),
    item('open.character', '角色', page(ports, MENU_ROUTES.character)), item('open.monitor', '诊断', page(ports, MENU_ROUTES.monitor)),
    item('open.settings', '设置…', page(ports, MENU_ROUTES.settings))]));
  const e: MenuItem[] = [
    label('status', `${name} · ${status}`),
    item('conversation', '打开对话', page(ports, MENU_ROUTES.conversation)),
    item('quickInput', '快速输入…', ports.quickInput, { accelerator: menuAccelerator(s.quickInputHotkey) }),
    submenu('show', '给她看', [
      item('handClipboard', '把剪贴板交给她', ports.handClipboard),
      item('selectRegion', '框选给她看…', ports.selectRegion),
      item('look', '屏幕识读', ports.look, { accelerator: menuAccelerator(s.lookHotkey) })]),
  ];
  const poses = poseItem(s, ports);
  if (poses) e.push(poses);
  e.push(item('gift', '送礼物', ports.giveGift),
    submenu('character', '角色', roles, { enabled: !s.characterSwitching }), SEPARATOR,
    quietItem(s, ports), hiddenItem(s, ports), SEPARATOR,
    submenu('more', '更多', more));
  return e;
}

/** null without `poses`; a slot without material is greyed. */
function poseItem(s: MenuState, ports: MenuPorts): MenuItem | null {
  if (s.poses.length === 0) return null;
  const set = ports.setPose;
  return submenu('poses', '姿态', [
    item('pose.auto', '自动', set && (() => set(null)), { checked: s.currentPose === null }),
    ...s.poses.map((p) => item(`pose.${p.slot}`, p.available ? p.title : `${p.title}（缺素材）`, set && (() => set(p.id)),
      { checked: p.id !== null && p.id === s.currentPose, enabled: p.available })),
    SEPARATOR, item('poseLock', '锁定当前姿态', ports.togglePoseLock, { checked: s.poseLocked }),
  ]);
}

/** null without layers; a check means the layer is shown. */
function layersItem(s: MenuState, ports: MenuPorts): MenuItem | null {
  if (s.layers.length === 0) return null;
  const enabled = !s.characterSwitching && s.appearanceSwitchingTo === null && !s.layersSwitching, flip = ports.toggleLayer;
  return submenu('layers', '服装分层', s.layers.map((l) => item(`layer.${l.id}`, l.name, flip && (() => flip(l.id)),
    { checked: l.visible, enabled })), { enabled });
}

/** null without MMD slots. */
function mmdItem(s: MenuState, ports: MenuPorts): MenuItem | null {
  if (s.motionSlots.length === 0) return null;
  const play = ports.playSlot, loop = ports.setPlaylistLoop;
  const loops = ([['不循环', 'off'], ['单曲', 'one'], ['全部', 'all']] as const).map(([title, value]) =>
    item(`loop.${value}`, title, loop && (() => loop(value)), { checked: value === s.playlistLoop }));
  return submenu('mmd', 'MMD', [
    ...s.motionSlots.map((m) => item(`slot.${m.id}`, m.name, play && (() => play(m.id)), { checked: m.id === s.playingSlot })),
    SEPARATOR, item('playlist', '连播', ports.playPlaylist),
    submenu('loop', '循环', loops),
    item('stopPlaylist', '停止', ports.stopPlaylist, { enabled: s.playlistPlaying }),
  ]);
}
