"""MFA (kalpy in-process, CPU, beam 10) aligner subprocess for C2 cues revision 2. Run with the MFA env python, e.g.
<mfa-env>/bin/python mfa_worker.py
stdin: one JSON request per line {id, lang, phones, word2ph, norm_text, pcm_base64 (speech part only, 48 kHz s16le)}.
stdout: {"ready":true} once both languages are loaded, then one reply per request
{id, ok:true, beam:10, phones:[{index, phone, start, end}]} (samples from the start of the speech part) or {id, ok:false, error}.
Dictionary generation, alignment and the mapping back to GSV phones are copied from audio/alignment-bench/mfa_align.py and units.py (gsvlex mode)."""
import base64,json,os,pathlib,sys,tempfile,wave
ROOT=pathlib.Path(os.environ.get('AAC_VOICE_ROOT','/srv/tts'));REPO=pathlib.Path(os.environ.get('AAC_GPT_SOVITS') or ROOT/'GPT-SoVITS')
os.environ.setdefault('MFA_ROOT_DIR',str(ROOT/'models/mfa_root'))
PRETRAINED=pathlib.Path(os.environ['MFA_ROOT_DIR'])/'pretrained_models'
ACOUSTIC={'zh':PRETRAINED/'acoustic/mandarin_mfa.zip','ja':PRETRAINED/'acoustic/japanese_mfa.zip'}
OPENCPOP=REPO/'GPT_SoVITS/text/opencpop-strict.txt'
CACHE=pathlib.Path(__file__).resolve().parent/'mfa-lexicon'
SR=48000

# ---- GSV phone units (units.py) ----
JA_VOWELS={'a','i','u','e','o','A','I','U','E','O'}
JA_CONSONANTS={'k','g','s','sh','z','j','t','ch','ts','d','n','h','f','m','y','r','w','b','p','v','ky','gy','ny','hy','my','ry','by','py','dy','ty'}
JA_PHONES=JA_VOWELS|JA_CONSONANTS|{'N','cl'}
ZH_NON_PHONES={'SP','SP2','SP3','UNK'}

def is_phone(lang,symbol):
    if lang=='ja':return symbol in JA_PHONES
    return symbol not in ZH_NON_PHONES and any(c.isalpha() for c in symbol)

def zh_units(segment):
    """One unit per character that carries phones: {'phones':[index into segment phones]}."""
    phones,word2ph,text=segment['phones'],segment['word2ph'],segment['norm_text']
    # GSV gives no word2ph when the segment mixes in English, and the zh lexicon has no English phones.
    if word2ph is None:raise ValueError('no word2ph (mixed-language segment); zh MFA needs per-character phones')
    assert len(word2ph)==len(text) and sum(word2ph)==len(phones)
    units=[];pos=0
    for char,n in zip(text,word2ph):
        idx=list(range(pos,pos+n));pos+=n
        if all(is_phone('zh',phones[i]) for i in idx):units.append({'label':char,'phones':idx})
        else:assert not any(is_phone('zh',phones[i]) for i in idx),(char,[phones[i] for i in idx])
    return units

def ja_morae(phones):
    """Morae over the phone symbols only: consonants + vowel, or N / cl alone. Prosody marks and punctuation are skipped."""
    units=[];pending=[];boundary=False
    for i,p in enumerate(phones):
        if not is_phone('ja',p):
            # Pitch marks sit inside a word; anything else (accent-phrase UNK, punctuation) separates words.
            boundary=boundary or p not in ('[',']');continue
        if p in JA_VOWELS:units.append({'cons':[phones[j] for j in pending],'vowel':p,'phones':pending+[i],'after_boundary':boundary});pending=[];boundary=False
        elif p in ('N','cl'):
            assert not pending,phones;units.append({'cons':[],'vowel':p,'phones':[i],'after_boundary':boundary});boundary=False
        else:pending.append(i)
    assert not pending,phones
    prev=None
    for u in units:
        v=u['vowel'].lower()
        # A bare vowel after a same-vowel mora in the same word is a long-vowel continuation (openjtalk writes ou/oo as "o o").
        u['long']=not u['cons'] and not u['after_boundary'] and prev is not None and prev not in ('n','cl') and v==prev
        prev=v
    return units

# ---- zh: GSV initial/final+tone -> mandarin_mfa v3 phones ----
ZH_INIT={'b':'p','p':'pʰ','m':'m','f':'f','d':'t','t':'tʰ','n':'n','l':'l','g':'k','k':'kʰ','h':'x','j':'tɕ','q':'tɕʰ','x':'ɕ',
         'zh':'ʈʂ','ch':'ʈʂʰ','sh':'ʂ','r':'ʐ','z':'ts','c':'tsʰ','s':'s'}
ZH_FINAL={'a':['a*'],'o':['o*'],'e':['o*'],'E':['e*'],'ai':['aj*'],'ei':['ej*'],'ao':['aw*'],'ou':['ow*'],'an':['a*','n'],'En':['e*','n'],
          'en':['ə*','n'],'ang':['a*','ŋ'],'eng':['o*','ŋ'],'ong':['u*','ŋ'],'er':['o*','ɻ'],
          'i':['i*'],'ia':['j','a*'],'ie':['j','e*'],'iao':['j','aw*'],'iu':['j','ow*'],'ian':['j','e*','n'],'in':['i*','n'],'iang':['j','a*','ŋ'],
          'ing':['i*','ŋ'],'iong':['j','u*','ŋ'],'u':['u*'],'ua':['w','a*'],'uo':['w','o*'],'uai':['w','aj*'],'ui':['w','ej*'],'uan':['w','a*','n'],
          'un':['w','ə*','n'],'uang':['w','a*','ŋ'],'v':['y*'],'ve':['ɥ','e*'],'van':['ɥ','e*','n'],'vn':['y*','n'],'ir':['ʐ̩*'],'i0':['z̩*']}
ZH_TONE={'1':'˥','2':'˧˥','3':'˨˩˦','4':'˥˩','5':''}

def zh_prons(initial,final,tone):
    """[(n_initial_phones, phones)] alternatives for one GSV syllable."""
    fin=list(ZH_FINAL[final])
    if final=='o' and initial in ('b','p','m','f'):fin=['w','o*']
    if final=='e' and tone=='5':fin=['ə*']
    if initial in ('AA','EE','OO'):inits=[['ʔ'],[]]
    elif initial=='y':inits=[[] if final in ('i','in','ing','v','van','ve','vn') else ['j']]
    elif initial=='w':inits=[[] if final=='u' else ['w']]
    else:
        c=ZH_INIT[initial]
        if c in ('tɕ','tɕʰ','ɕ') and fin[0]=='j':fin=fin[1:]
        if c in ('tɕ','tɕʰ','ɕ') and fin[0]=='ɥ':c,fin={'tɕ':'tɕʷ','tɕʰ':'tɕʷ','ɕ':'ɕʷ'}[c],fin[1:]
        inits=[[c]]
    fin=[p.replace('*',ZH_TONE[tone]) for p in fin]
    return [(len(i),i+fin) for i in inits]

def zh_lexicon():
    """Token per GSV syllable+tone, e.g. 'zh_ong1' ('_' because MFA's tokenizer splits words at '.' and '-'); returns {token:[(n_init,phones)]}."""
    lex={}
    for line in OPENCPOP.read_text().splitlines():
        initial,final=line.split('\t')[1].split(' ')
        for tone in '12345':lex[f'{initial}_{final}{tone}']=zh_prons(initial,final,tone)
    return lex

def zh_tokens(segment):
    """(token, gsv initial index, gsv final index) per character unit."""
    out=[]
    for u in zh_units(segment):
        assert len(u['phones'])==2,(u,segment['phones'])
        i,f=(segment['phones'][k] for k in u['phones'])
        out.append((f'{i}_{f}',u['phones'][0],u['phones'][1]))
    return out

# ---- ja: openjtalk phones -> japanese_mfa v3 phones ----
JA_CONS={'k':'k','g':'ɡ','s':'s','sh':'ɕ','z':'dz','j':'dʑ','t':'t','ch':'tɕ','ts':'ts','d':'d','n':'n','h':'h','f':'ɸ','m':'m','y':'j','r':'ɾ','w':'w',
         'b':'b','p':'p','v':'v','ky':'c','gy':'ɟ','ny':'ɲ','hy':'ç','my':'mʲ','ry':'ɾʲ','by':'bʲ','py':'pʲ','dy':'dʲ','ty':'tʲ'}
JA_BEFORE_I={'k':'c','g':'ɟ','n':'ɲ','h':'ç','m':'mʲ','r':'ɾʲ','b':'bʲ','p':'pʲ','t':'tʲ','d':'dʲ','z':'dʑ','s':'ɕ','v':'vʲ'}
JA_U_CENTRAL={'s','ts','dz','z','ɕ','tɕ','dʑ'}
JA_N=['ɴ','m','n','ŋ','ɰ̃','ɲ']

def ja_cons(cons,vowel):
    if not cons:return None
    if vowel.lower()=='i' and cons in JA_BEFORE_I:return JA_BEFORE_I[cons]
    if vowel.lower()=='u' and cons=='h':return 'ɸ'
    return JA_CONS[cons]

def ja_vowels(cons_phone,vowel,length):
    """Alternatives for the vowel phone: voiced always; devoiced i/u also offered (japanese_mfa rules allow devoicing)."""
    v=vowel.lower()
    base={'a':'a','i':'i','e':'e','o':'o','u':'ɨ' if cons_phone in JA_U_CENTRAL else 'ɯ'}[v]
    if length>1:return [base+'ː']
    return [base,base+'̥'] if v in ('i','u') else [base]

def ja_token(group,phone_set):
    """group: list of morae = [cl?] base [long...]. Returns (name, [phones alternatives], pieces).
    pieces: (gsv phone index, phone position, fraction start, fraction end)."""
    name='_'.join('q' if m['vowel']=='cl' else 'nn' if m['vowel']=='N' else ''.join(m['cons'])+m['vowel'] for m in group)
    pieces=[];alts=[[]]
    head=group[0]
    if head['vowel']=='N':
        assert len(group)==1;return name,[[p] for p in JA_N],[(head['phones'][0],0,0.,1.)]
    gem=head['vowel']=='cl'
    if gem and (len(group)==1 or not group[1]['cons']):
        assert len(group)==1,group;return name,[['ʔ']],[(head['phones'][0],0,0.,1.)]
    base=group[1] if gem else head
    longs=group[2:] if gem else group[1:]
    c=ja_cons(base['cons'][0] if base['cons'] else None,base['vowel']);pos=0
    if gem:
        if c+'ː' in phone_set:
            alts=[[c+'ː']];pieces+=[(head['phones'][0],0,0.,.5),(base['phones'][0],0,.5,1.)];pos=1
        else:
            alts=[['ʔ',c]];pieces+=[(head['phones'][0],0,0.,1.),(base['phones'][0],1,0.,1.)];pos=2
    elif c:
        alts=[[c]];pieces.append((base['phones'][0],0,0.,1.));pos=1
    vowels=ja_vowels(c,base['vowel'],1+len(longs))
    alts=[a+[v] for a in alts for v in vowels if v in phone_set]
    n=1+len(longs)
    for k,m in enumerate([base]+longs):pieces.append((m['phones'][-1],pos,k/n,(k+1)/n))
    return name,alts,pieces

def ja_groups(morae):
    groups=[];i=0
    while i<len(morae):
        g=[morae[i]];i+=1
        if g[0]['vowel']=='cl' and i<len(morae) and morae[i]['cons']:g.append(morae[i]);i+=1
        if g[-1]['vowel'] not in ('N','cl'):
            while i<len(morae) and morae[i]['long']:g.append(morae[i]);i+=1
        groups.append(g)
    return groups

def ja_lexicon(phone_set):
    """Full inventory: every consonant x vowel (voiced/devoiced) x geminate x up to 2 long continuations, plus N and lone cl."""
    lex={}
    def mora(cons,vowel,idx,long=False):return {'cons':[cons] if cons else [],'vowel':vowel,'phones':idx,'long':long}
    for cons in ['']+sorted(JA_CONSONANTS):
        for vowel in 'aiueoAIUEO':
            for gem in ([False,True] if cons else [False]):
                for extra in range(3):
                    g=([mora('','cl',[0])] if gem else [])+[mora(cons,vowel,[1,2] if cons else [2])]+[mora('',vowel.lower(),[3+k],True) for k in range(extra)]
                    name,alts,_=ja_token(g,phone_set)
                    if alts:lex[name]=alts
    lex['nn']=[[p] for p in JA_N if p in phone_set];lex['q']=[['ʔ']]
    return lex

def transcript_words(lang,segment,phone_set):
    """[(word, data)] in spoken order. zh data: (initial index, final index); ja data: pieces from ja_token; data is None for <unk>.
    Each part in another language (English) becomes one <unk> word, which kalpy aligns to the model's spn phone."""
    # Without parts, English phones cannot be told apart (ja N and ARPAbet N share a symbol) and would be aligned as ja or dropped.
    if segment.get('parts') is None:raise ValueError('segment parts are required to find other-language phones')
    words=[]
    for part in segment['parts']:
        start,phones=part['start'],segment['phones'][part['start']:part['end']]
        if part['lang']!=lang:
            if any(is_phone(part['lang'],p) for p in phones):words.append(('<unk>',None))
        elif lang=='zh':
            words+=[(t[0],(t[1]+start,t[2]+start)) for t in zh_tokens({'phones':phones,'word2ph':part['word2ph'],'norm_text':part['norm_text']})]
        else:
            for name,_,pieces in (ja_token(g,phone_set) for g in ja_groups(ja_morae(phones))):words.append((name,[(i+start,*rest) for i,*rest in pieces]))
    return words

# ---- MFA engine (gsvlex mode, beam 10 only) ----
class Aligner:
    def __init__(self,lang,wav_path):
        from kalpy.aligner import KalpyAligner
        from kalpy.fstext.lexicon import LexiconCompiler
        from montreal_forced_aligner.models import AcousticModel
        import pywrapfst
        self.lang=lang;self.wav_path=wav_path
        self.model=AcousticModel(ACOUSTIC[lang]);params=self.model.parameters
        self.phone_set=set(params['non_silence_phones'])
        cache=CACHE/lang;cache.mkdir(parents=True,exist_ok=True)
        self.lex=zh_lexicon() if lang=='zh' else ja_lexicon(self.phone_set)
        self.n_init={}
        dict_path=cache/f'gsvlex_{lang}.dict'
        lines=[]
        for token,alts in sorted(self.lex.items()):
            for alt in alts:
                n,phones=alt if lang=='zh' else (None,alt)
                if any(p not in self.phone_set for p in phones):raise ValueError(f'{token} {phones} not in acoustic phone set')
                if lang=='zh':self.n_init[(token,' '.join(phones))]=n
                lines.append(token+'\t'+' '.join(phones))
        text='\n'.join(lines)+'\n'
        if not dict_path.exists() or dict_path.read_text()!=text:
            dict_path.write_text(text)
            for f in ('L.fst','L_align.fst','words.txt','phones.txt'):(cache/f).unlink(missing_ok=True)
        lc=LexiconCompiler(disambiguation=False,silence_probability=params['silence_probability'],initial_silence_probability=params['initial_silence_probability'],
                           final_silence_correction=params['final_silence_correction'],final_non_silence_correction=params['final_non_silence_correction'],
                           silence_phone=params['optional_silence_phone'],oov_phone=params['oov_phone'],position_dependent_phones=params['position_dependent_phones'],
                           phones=params['non_silence_phones'],ignore_case=False)
        if (cache/'L.fst').exists():
            lc.load_l_from_file(cache/'L.fst');lc.load_l_align_from_file(cache/'L_align.fst')
            lc.word_table=pywrapfst.SymbolTable.read_text(cache/'words.txt');lc.phone_table=pywrapfst.SymbolTable.read_text(cache/'phones.txt')
        else:
            lc.load_pronunciations(dict_path);lc.create_fsts();lc.clear()
            lc.fst.write(str(cache/'L.fst'));lc.align_fst.write(str(cache/'L_align.fst'));lc.word_table.write_text(cache/'words.txt');lc.phone_table.write_text(cache/'phones.txt')
        self.kalpy=KalpyAligner(self.model,lc)

    def ctm(self,pcm,transcript):
        from kalpy.feat.cmvn import CmvnComputer
        from kalpy.utterance import Segment,Utterance
        # kalpy reads audio (and pitch for the Mandarin model) from a file path.
        with wave.open(str(self.wav_path),'wb') as w:
            w.setnchannels(1);w.setsampwidth(2);w.setframerate(SR);w.writeframes(pcm)
        utt=Utterance(Segment(str(self.wav_path),0.,len(pcm)//2/SR,0),transcript)
        utt.generate_mfccs(self.model.mfcc_computer)
        utt.apply_cmvn(CmvnComputer().compute_cmvn_from_features([utt.mfccs]))
        result=self.kalpy.align_utterance(utt)
        to_sample=lambda t:int(round(t*SR))
        return [{'word':w.label,'start':to_sample(w.begin),'end':to_sample(w.end),'phones':[{'phone':p.label,'start':to_sample(p.begin),'end':to_sample(p.end)} for p in w.phones]}
                for w in result.word_intervals]

    def align(self,segment,pcm):
        """GSV phone intervals in samples from the start of pcm."""
        entries=transcript_words(self.lang,segment,self.phone_set);names=[e[0] for e in entries]
        words=[w for w in self.ctm(pcm,' '.join(names)) if w['word'] not in ('<eps>','sil','')]
        assert [w['word'] for w in words]==names,([w['word'] for w in words],names)
        phones={}
        for (name,data),w in zip(entries,words):
            ph=w['phones']
            if data is None:continue
            if self.lang=='zh':
                ini,fin=data;n=self.n_init[(name,' '.join(p['phone'] for p in ph))]
                if n:phones[ini]={'start':ph[0]['start'],'end':ph[n-1]['end']}
                phones[fin]={'start':ph[n]['start'],'end':ph[-1]['end']}
            else:
                for idx,pos,f0,f1 in data:
                    p=ph[pos];span=p['end']-p['start']
                    a,b=p['start']+int(round(span*f0)),p['start']+int(round(span*f1))
                    if idx in phones:phones[idx]={'start':min(a,phones[idx]['start']),'end':max(b,phones[idx]['end'])}
                    else:phones[idx]={'start':a,'end':b}
        return [{'index':i,'phone':segment['phones'][i],**phones[i]} for i in sorted(phones)]

def main():
    # Replies own the real stdout; anything else written to fd 1 (library prints) goes to stderr.
    out=os.fdopen(os.dup(1),'w',encoding='utf-8');os.dup2(2,1);sys.stdout=sys.stderr
    from kalpy.exceptions import AlignerError
    tmp=tempfile.TemporaryDirectory()
    aligners={lang:Aligner(lang,pathlib.Path(tmp.name)/'segment.wav') for lang in ('zh','ja')}
    out.write(json.dumps({'ready':True})+'\n');out.flush()
    for line in sys.stdin:
        r=json.loads(line)
        try:reply={'id':r['id'],'ok':True,'beam':10,'phones':aligners[r['lang']].align(r,base64.b64decode(r['pcm_base64']))}
        # Beam 10 failing usually means the synthesis itself went wrong (alignment-bench REPORT §5, ja09), so no wide-beam retry.
        except AlignerError:reply={'id':r['id'],'ok':False,'error':'beam'}
        except Exception as exc:reply={'id':r['id'],'ok':False,'error':f'{type(exc).__name__}: {exc}'}
        out.write(json.dumps(reply,ensure_ascii=False)+'\n');out.flush()

if __name__=='__main__':main()
