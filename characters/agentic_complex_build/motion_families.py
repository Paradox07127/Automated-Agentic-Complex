"""The motion checks and action-row timing build_original_agent_motion and motion_import.chain_edit share; standard library only,
so the app's content runtime can run them."""


def pooled(mapping):
    """Every clip a desktop pool, tier, activity, fidget, speech, click or reviewed library context draws."""
    clips={p['clip']for e in list(mapping.get('events',{}).values())+mapping.get('idle_tiers',[])for p in e['pool']}
    clips|={c for moods in mapping.get('activities',{}).values()for pool in moods.values()for c in pool}
    clips|=set(mapping.get('idle_fidget',{}).get('clips',[]))|set((mapping.get('speech_gestures')or{}).get('clips',[]))|set(mapping.get('click_reactions')or[])
    return clips|{c for c,r in mapping.get('motion_library',{}).items()if r.get('reviewed')and r.get('contexts')}


def check_families(document, mapping, metadata, clips):
    """Each newly pooled standing clip starts in the hub's family or one a hub bridge leads to, and its chain comes to rest on a base;
    a motion-library row's `unbridged` reason opts its clip out. Returns {clip: reason} of the clips opted out."""
    hub=document['hub'];reach={hub}|{b for a,_,b in(k.partition('>')for k in document['bridges'])if a==hub}
    opted={c:r['unbridged']for c,r in mapping.get('motion_library',{}).items()if r.get('unbridged')and c in clips}
    for clip in sorted(c for c in clips if metadata[c]['stance_start']=='stand'):
        if clip not in document['clips']:raise ValueError('pool_pose_unmeasured:'+clip)
        if clip in opted:continue
        if document['clips'][clip]['start']not in reach:raise ValueError('pool_start_family_unbridged:'+clip)
        last,seen=clip,set()
        while last not in seen and (mapping['clips'].get(last,{}).get('next')or mapping['clips'].get(last,{}).get('exit')):
            seen.add(last);last=mapping['clips'][last].get('next')or mapping['clips'][last]['exit']
        if document['clips'].get(last,{}).get('end')not in document['bases']:raise ValueError('pool_chain_end_off_base:'+clip)
    return opted


def chain_timing(chain, lengths):
    """required_clips and duration of the action row that plays chain from its first clip: one cycle of each clip of lengths."""
    return dict(required_clips=chain[1:],duration=sum(lengths[n]for n in chain))
