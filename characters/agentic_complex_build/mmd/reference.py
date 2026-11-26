"""Authored standard-control reference; not a recovered character/model asset."""
import numpy as np
from .io import Pmd, PmdBone, PmdIK
FINGER_LAYOUT = {  # base offset (along forearm f, along index-side a, along palmar n) and joint spacings
    '人指': ((0.95, 0.32, 0.0), (0.42, 0.30)), '中指': ((1.0, 0.08, 0.0), (0.46, 0.32)),
    '薬指': ((0.95, -0.15, 0.0), (0.42, 0.30)), '小指': ((0.85, -0.36, 0.0), (0.32, 0.24))}


def unit(v):
    v = np.asarray(v, float)
    return v / np.linalg.norm(v)


def mirror_pos(p):
    return np.asarray(p, float) * [-1, 1, 1]


def rh_bones():
    """[(name, parent, pos RH, type, influence source, tail weight)] for a standard PMD skeleton."""
    out = []

    def add(name, parent, pos, typ=0, src=None, weight=0):
        out.append((name, parent, np.asarray(pos, float), typ, src, weight))
    add('センター', None, (0, 8.0, 0), 1)
    add('上半身', 'センター', (0, 11.3, 0.1))
    add('首', '上半身', (0, 15.7, -0.1))
    add('頭', '首', (0, 16.4, 0.0))
    add('両目', '頭', (0, 17.4, 0.6))
    add('左目', '頭', (0.6, 17.4, 0.8), 5, '両目')
    add('右目', '頭', (-0.6, 17.4, 0.8), 5, '両目')
    add('下半身', 'センター', (0, 11.3, 0.1))
    f = unit((2.1, -1.64, 0))
    a = np.array([0, 0, 1.0])
    n = np.cross(f, a)  # palmar normal of the palm-down left hand
    for s, sx in [('左', 1), ('右', -1)]:
        P = (lambda p: np.asarray(p, float)) if sx > 0 else mirror_pos
        add(s + '肩', '上半身', P((0.3, 15.25, 0.0)))
        add(s + '腕', s + '肩', P((1.3, 15.0, -0.05)))
        add(s + '腕捩', s + '腕', P((2.45, 14.1, -0.075)), 8)
        add(s + '腕捩1', s + '腕', P((2.0, 14.45, -0.07)), 9, s + '腕捩', 50)
        add(s + 'ひじ', s + '腕捩', P((3.6, 13.2, -0.1)))
        add(s + '手捩', s + 'ひじ', P((4.65, 12.38, -0.1)), 8)
        wrist = np.array((5.7, 11.56, -0.1))
        add(s + '手首', s + '手捩', P(wrist))
        t1 = wrist + 0.3 * f + 0.32 * a + 0.12 * n
        dt = unit(0.55 * f + 0.75 * a + 0.35 * n)
        add(s + '親指１', s + '手首', P(t1))
        add(s + '親指２', s + '親指１', P(t1 + 0.45 * dt))
        for fn, (base, sp) in FINGER_LAYOUT.items():
            p1 = wrist + base[0] * f + base[1] * a + base[2] * n
            add(s + fn + '１', s + '手首', P(p1))
            add(s + fn + '２', s + fn + '１', P(p1 + sp[0] * f))
            add(s + fn + '３', s + fn + '２', P(p1 + (sp[0] + sp[1]) * f))
    for s, sx in [('左', 1), ('右', -1)]:
        P = (lambda p: np.asarray(p, float)) if sx > 0 else mirror_pos
        add(s + '足', '下半身', P((0.95, 10.4, 0.1)))
        add(s + 'ひざ', s + '足', P((0.95, 5.85, 0.15)), 4)
        add(s + '足首', s + 'ひざ', P((0.95, 1.25, 0.05)), 4)
        add(s + 'つま先', s + '足首', P((0.95, 0.15, 1.15)), 6)
    for s, sx in [('左', 1), ('右', -1)]:
        P = (lambda p: np.asarray(p, float)) if sx > 0 else mirror_pos
        add(s + '足ＩＫ', None, P((0.95, 1.25, 0.05)), 2)
        add(s + 'つま先ＩＫ', s + '足ＩＫ', P((0.95, 0.15, 1.15)), 2)
    return out


def build_pmd():
    rb = rh_bones()
    names = [b[0] for b in rb]
    ix = {n: i for i, n in enumerate(names)}
    kids = {}
    for i, b in enumerate(rb):
        if b[1] is not None:
            kids.setdefault(ix[b[1]], []).append(i)
    bones = []
    for i, (name, parent, pos, typ, src, weight) in enumerate(rb):
        tail = weight if typ == 9 else (kids[i][0] if i in kids else 0)
        ik = ix[src] if src is not None else 0
        lh = pos * [1, 1, -1]
        bones.append(PmdBone(name, -1 if parent is None else ix[parent], tail, typ, ik, tuple(float(x) for x in lh)))
    iks = []
    for s in '左右':
        iks.append(PmdIK(ix[s + '足ＩＫ'], ix[s + '足首'], 40, 0.5, [ix[s + 'ひざ'], ix[s + '足']]))
    for s in '左右':
        iks.append(PmdIK(ix[s + 'つま先ＩＫ'], ix[s + 'つま先'], 3, 1.0, [ix[s + '足首']]))
    return Pmd(name='w4合成ミク', comment='synthetic w4 fixture', bones=bones, iks=iks)
