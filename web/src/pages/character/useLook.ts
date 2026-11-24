import { useContext, useEffect, useRef, useState } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { getBridge, type AvatarState } from '../../bridge';

/** What the avatar shows now, then the menus and the resize overlay; a push beats a later state() reply. */
export function useLook() {
  const canAvatar = getBridge().capabilities.avatar;
  const [id, setId] = useState<string | null>(null);
  const [scale, setScale] = useState(100);
  const [visible, setVisible] = useState<boolean | null>(null);
  useEffect(() => {
    if (!canAvatar) return;
    let live = true;
    let pushed = false;
    const apply = (a: AvatarState) => {
      if (!live) return;
      if (a.appearanceId) setId(a.appearanceId);
      setVisible(a.visible);
      setScale(Math.round(a.scale * 100));
    };
    getBridge()
      .avatar.state()
      .then((a) => !pushed && apply(a))
      .catch(() => {});
    const off = getBridge().avatar.onState((a) => {
      pushed = true;
      apply(a);
    });
    return () => {
      live = false;
      off();
    };
  }, [canAvatar]);
  return { id, setId, scale, setScale, visible };
}

/** The roster lists the layers of the appearance she wears: another one, put on here or from the menus, reads it again. */
export function useRosterFollowsLook(id: string | null) {
  const qc = useContext(QueryClientContext);
  const worn = useRef(id);
  useEffect(() => {
    if (worn.current != null && id !== worn.current) void qc?.invalidateQueries({ queryKey: ['character', 'list'] });
    worn.current = id;
  }, [id, qc]);
}
