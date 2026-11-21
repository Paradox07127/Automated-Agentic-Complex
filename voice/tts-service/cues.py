"""C2 `cues` events: revision 1 from MRTE attention (in process), revision 2 from an MFA worker subprocess. Standard library + numpy."""
import base64,json,queue,subprocess,sys,threading,time
import numpy as np
FRAME_SAMPLES=960
# Best variants on the alignment bench (audio/alignment-bench/REPORT.md §5-§6): zh head 0, ja mean of heads; pauses only at punctuation.
HEAD={'zh':'h0','ja':'mean'}
PUNCT={',','.','?','!','…','-'}
JA_VOWELS={'a','i','u','e','o','A','I','U','E','O'}
JA_CONSONANTS={'k','g','s','sh','z','j','t','ch','ts','d','n','h','f','m','y','r','w','b','p','v','ky','gy','ny','hy','my','ry','by','py','dy','ty'}
JA_PHONES=JA_VOWELS|JA_CONSONANTS|{'N','cl'}
ZH_NON_PHONES={'SP','SP2','SP3','UNK'}

def is_phone(lang,symbol):
    if lang=='ja':return symbol in JA_PHONES
    return symbol not in ZH_NON_PHONES and any(c.isalpha() for c in symbol)

def viterbi(phone_logp,sil_logp,sil_allowed):
    """States alternate silence/phone: S0 P0 S1 P1 ... P(M-1) SM. Silence states are optional; every phone gets >=1 frame."""
    T,M=phone_logp.shape;S=2*M+1
    if T<M:return None
    emit=np.empty((T,S));emit[:,1::2]=phone_logp;emit[:,0::2]=np.where(sil_allowed[None,:],sil_logp[:,None],-np.inf)
    score=np.full(S,-np.inf);score[0]=emit[0,0];score[1]=emit[0,1]
    back=np.zeros((T,S),np.int8)
    odd=np.zeros(S,bool);odd[1::2]=True
    for t in range(1,T):
        stay=score;adv=np.concatenate([[-np.inf],score[:-1]]);skip=np.concatenate([[-np.inf,-np.inf],score[:-2]])
        skip=np.where(odd,skip,-np.inf)
        cand=np.stack([stay,adv,skip]);choice=cand.argmax(0)
        score=cand[choice,np.arange(S)]+emit[t];back[t]=choice
    end=S-1 if score[S-1]>=score[S-2] else S-2
    path=np.empty(T,np.int64);s=end
    for t in range(T-1,-1,-1):
        path[t]=s;s-=int(back[t,s])
    return path

def mrte_spans(lang,phones,attn,start_sample,parts=None):
    """attn: target-sentence MRTE attention [heads, 2N, P]. parts: segment_meta parts; phones in a part are judged by that part's language.
    Returns per-phone sample spans; [] when there are fewer frames than phones."""
    head=HEAD[lang];langs=[lang]*len(phones)
    for part in parts or []:langs[part['start']:part['end']]=[part['lang']]*(part['end']-part['start'])
    # English phones counted as silence would let the opening silence swallow the ja phones before them.
    cols=[i for i,p in enumerate(phones) if is_phone(langs[i],p)]
    other=[i for i in range(attn.shape[2]) if i not in set(cols)]
    probs=attn.mean(0) if head=='mean' else attn[int(head[1:])]
    phone_logp=np.log(probs[:,cols]+1e-6)
    sil_logp=np.log(probs[:,other].sum(1)+1e-6) if other else np.full(probs.shape[0],np.log(1e-6))
    allowed=np.ones(len(cols)+1,bool)
    allowed[1:-1]=[any(p in PUNCT for p in phones[a+1:b]) for a,b in zip(cols,cols[1:])]
    path=viterbi(phone_logp,sil_logp,allowed)
    if path is None:return []
    spans=[]
    for j,col in enumerate(cols):
        frames=np.nonzero(path==2*j+1)[0]
        spans.append({'index':col,'phone':phones[col],'start':start_sample+FRAME_SAMPLES*int(frames[0]),'end':start_sample+FRAME_SAMPLES*(int(frames[-1])+1),
                      'confidence':min(1.,max(0.,float(probs[frames,col].mean())))})
    return spans

def load_vowel_map(path):
    with open(path,encoding='utf-8') as f:return json.load(f)['phones']

def cue_items(spans,vowel_map,lo,hi):
    """Spans of mapped phones clipped to [lo, hi); unmapped phones and empty spans are dropped (C2 rules 1 and 6)."""
    items=[]
    for s in spans:
        entry=vowel_map.get(s['phone']);start,end=max(s['start'],lo),min(s['end'],hi)
        if entry is None or start>=end:continue
        items.append({'start':start,'end':end,'phone':s['phone'],'vowel':entry['vowel'],'weight':entry['weight'],'confidence':s['confidence']})
    return items

class MfaClient:
    """One mfa_worker.py subprocess shared by all streams. Requests are written serially by a writer thread; a reader thread dispatches replies by id.
    When the worker exits, its waiters fail with mfa_worker_exit and the reader restarts it with backoff until close()."""
    MAX_INFLIGHT=8;RESTART_FIRST_SECONDS=1.;RESTART_MAX_SECONDS=30.
    def __init__(self,argv):
        self.argv=argv;self.proc=self.start()
        self.lock=threading.Lock();self.waiters={};self.next_id=0;self.requests=queue.Queue();self.available=True;self.closing=threading.Event()
        threading.Thread(target=self.write,daemon=True).start();threading.Thread(target=self.read,daemon=True).start()
    def start(self):
        proc=subprocess.Popen(self.argv,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,encoding='utf-8')
        ready=proc.stdout.readline()
        try:ok=json.loads(ready)=={'ready':True}
        except ValueError:ok=False
        if not ok:proc.kill();proc.wait();raise RuntimeError('MFA worker did not start: '+ready)
        return proc
    def submit(self,request,callback):
        """Never blocks on the pipe; callback(reply) runs on its own thread."""
        with self.lock:
            request_id=self.next_id;self.next_id+=1
            error='mfa_unavailable' if not self.available else 'mfa_busy' if len(self.waiters)>=self.MAX_INFLIGHT else None
            if error is None:self.waiters[request_id]=callback;proc=self.proc
        if error is not None:
            threading.Thread(target=callback,args=({'id':request_id,'ok':False,'error':error},),daemon=True).start();return
        self.requests.put((proc,json.dumps({'id':request_id,**request},ensure_ascii=False)+'\n'))
    def write(self):
        while (item:=self.requests.get()) is not None:
            proc,line=item
            # A write to an exited worker fails; the reader fails its waiters.
            try:proc.stdin.write(line);proc.stdin.flush()
            except (OSError,ValueError):pass
        try:self.proc.stdin.close()
        except OSError:pass
    def read(self):
        while True:
            for line in self.proc.stdout:
                try:reply=json.loads(line)
                except ValueError:print('MFA worker wrote a non-JSON line: '+line.rstrip(),file=sys.stderr,flush=True);continue
                with self.lock:callback=self.waiters.pop(reply['id'],None)
                if callback is None:print('MFA worker replied to an unknown id: '+line.rstrip(),file=sys.stderr,flush=True);continue
                # A callback can block on one slow client's full queue, so it must not run on this thread.
                threading.Thread(target=callback,args=(reply,),daemon=True).start()
            self.proc.wait()
            with self.lock:self.available=False;waiters,self.waiters=self.waiters,{}
            for request_id,callback in waiters.items():
                threading.Thread(target=callback,args=({'id':request_id,'ok':False,'error':'mfa_worker_exit'},),daemon=True).start()
            if not self.restart():return
    def restart(self):
        """Returns False once close() has been called."""
        delay=self.RESTART_FIRST_SECONDS
        while not self.closing.wait(delay):
            try:proc=self.start()
            except (OSError,RuntimeError) as e:
                print('MFA worker restart failed: '+str(e),file=sys.stderr,flush=True);delay=min(2*delay,self.RESTART_MAX_SECONDS);continue
            with self.lock:
                if not self.closing.is_set():self.proc=proc;self.available=True;return True
            proc.kill();proc.wait()
        return False
    def close(self):
        with self.lock:self.closing.set()
        self.requests.put(None);self.proc.wait();self.proc.stdout.close()

class CueStream:
    """Adds revision-1 MRTE cues right after each fragment and, with an MFA client, revision-2 cues when its replies arrive."""
    WAIT_SECONDS=5.
    def __init__(self,stream,lang,vowel_map,mfa,cancelled):
        self.stream=stream;self.lang=lang;self.vowel_map=vowel_map;self.mfa=mfa;self.cancelled=cancelled
        self.pending=[];self.warnings=[];self.answered=set();self.closed=False;self.deadline=None
    def fragment(self,pcm,samples,meta,tail_samples,generated_after_seconds):
        with self.stream.lock:
            segment,audio=self.stream.fragment(pcm,samples,meta,tail_samples,generated_after_seconds)
            index=segment['segment_index'];lo=segment['start_sample'];hi=lo+segment['speech_samples']
            self.stream.cues(index,1,'mrte-attn',cue_items(mrte_spans(self.lang,meta['phones'],meta['attn'],lo,meta.get('parts')),self.vowel_map,lo,hi))
        if self.mfa is None:return
        done=threading.Event();self.pending.append(done)
        def reply(r):
            try:
                with self.stream.lock:
                    if self.closed or self.cancelled.is_set():return
                    self.answered.add(index)
                    if not r['ok']:self.warnings.append({'segment_index':index,'error':r['error']});return
                    spans=[{**p,'start':lo+p['start'],'end':lo+p['end'],'confidence':1.} for p in r['phones']]
                    self.stream.cues(index,2,'mfa',cue_items(spans,self.vowel_map,lo,hi))
            # The client can disconnect while this reply waits on a full queue.
            except RuntimeError:pass
            finally:done.set()
        self.mfa.submit({'lang':self.lang,'phones':meta['phones'],'word2ph':meta['word2ph'],'norm_text':meta['norm_text'],'parts':meta.get('parts'),
                         'pcm_base64':base64.b64encode(pcm[:2*segment['speech_samples']]).decode('ascii')},reply)
    def complete(self,result):
        """Waits until WAIT_SECONDS after the first call for the outstanding MFA requests, then ends the stream; later replies are dropped."""
        if self.deadline is None:self.deadline=time.monotonic()+self.WAIT_SECONDS
        for done in self.pending:done.wait(max(0.,self.deadline-time.monotonic()))
        with self.stream.lock:
            self.closed=True
            timed_out=[{'segment_index':i,'error':'mfa_timeout'} for i in range(self.stream.segments) if self.mfa is not None and i not in self.answered]
            warnings=sorted(self.warnings+timed_out,key=lambda w:w['segment_index'])
            return self.stream.complete(cues_complete=not timed_out,result={**result,'cue_warnings':warnings})
    def end_cancelled(self,reason,**extra):
        with self.stream.lock:
            self.closed=True
            return self.stream.cancelled(reason,**extra)
