// 改名 and 删除 of an imported motion, on the 导入 pane and the MMD page.
import { Btn, Dialog } from '../../ui';
import type { MotionLibrary } from './useMotionLibrary';
import modal from '../../ui/Modal.module.css';

/** motion_tool's title rule: 1–64 characters once trimmed. */
const titleOk = (t: string) => {
  const n = [...t.trim()].length;
  return n >= 1 && n <= 64;
};

export type MotionEdit = { kind: 'rename'; id: string; title: string } | { kind: 'remove'; id: string };

/** 改名 or 删除动作 of an imported motion; `removeNote` says what the delete takes away. */
export function MotionEditDialog({ edit, removeNote, onEdit, library }: { edit: MotionEdit; removeNote: string; onEdit: (e: MotionEdit | null) => void; library: MotionLibrary }) {
  const close = () => onEdit(null);
  const saveTitle = (title: string) => {
    if (!titleOk(title)) return;
    close();
    library.rename(edit.id, title.trim());
  };

  if (edit.kind === 'rename')
    return (
      <Dialog
        open
        title="改名"
        onClose={close}
        footer={
          <>
            <Btn variant="secondary" onClick={close}>
              取消
            </Btn>
            <Btn variant="primary" disabled={!titleOk(edit.title)} disabledReason="名字要 1–64 个字" onClick={() => saveTitle(edit.title)}>
              保存
            </Btn>
          </>
        }
      >
        <label className={modal.field}>
          动作名
          <input
            className={modal.input}
            value={edit.title}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => onEdit({ ...edit, title: e.currentTarget.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveTitle(edit.title);
            }}
          />
        </label>
      </Dialog>
    );
  return (
    <Dialog
      open
      title="删除动作"
      onClose={close}
      footer={
        <>
          <Btn variant="secondary" onClick={close}>
            取消
          </Btn>
          <Btn
            variant="danger"
            onClick={() => {
              close();
              library.remove(edit.id);
            }}
          >
            删除
          </Btn>
        </>
      }
    >
      <p>{removeNote}</p>
    </Dialog>
  );
}
