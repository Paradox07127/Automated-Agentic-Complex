"""Per-fragment metadata for C2 speech streams, recorded from GPT-SoVITS engine calls."""
import base64,collections,threading
TOKEN_HOP_SAMPLES=1920
SCHEMA='endfield-speech-timeline-v1'
SCHEMA_V2='endfield-speech-timeline-v2'
CLAUSE_FIELDS=('utterance_id','clause_id','clause_index','spoken_text_revision','voice_profile_id','interrupt_policy','turn_generation')

def clause_fields(body):
    """body: request fields. Returns the seven clause fields when utterance_id is given, None when none of them is; ValueError otherwise."""
    given={k:body.get(k) for k in CLAUSE_FIELDS}
    if all(v is None for v in given.values()):return None
    for name in ('utterance_id','clause_id','voice_profile_id'):
        value=given[name]
        if not isinstance(value,str) or not 1<=len(value.encode('utf-8'))<=64:raise ValueError(f'{name} must be a string of 1-64 UTF-8 bytes')
    for name,low in (('clause_index',0),('spoken_text_revision',1),('turn_generation',0)):
        value=given[name]
        if type(value) is not int or value<low:raise ValueError(f'{name} must be an integer >= {low}')
    if given['interrupt_policy'] not in ('immediate','clause_end'):raise ValueError('interrupt_policy must be "immediate" or "clause_end"')
    # trace_id is optional: agentd rewrites it in begin either way.
    trace=body.get('trace_id')
    if trace is not None:
        if not isinstance(trace,str) or not 1<=len(trace.encode('utf-8'))<=64:raise ValueError('trace_id must be a string of 1-64 UTF-8 bytes')
        given['trace_id']=trace
    return given

class ModuleHook:
    """Keeps one hook on whatever module get() returns now; upstream TTS.run rebuilds its models after a failed run."""
    def __init__(self,get,hook,pre=False):
        self.get=get;self.hook=hook;self.pre=pre;self.module=None
    def ensure(self):
        module=self.get()
        if module is not self.module:
            (module.register_forward_pre_hook if self.pre else module.register_forward_hook)(self.hook);self.module=module

_accel=threading.local()
def bind_accel_hook(engine,hook):
    """Until called again with engine None, infer_batch calls from this thread on engine.t2s_accel first run hook.ensure()."""
    _accel.bound=None if engine is None else (engine,hook)
def wrap_infer_batch(cls):
    """Wraps cls.infer_batch once; the wrapper ensures the hook bound in the calling thread, then calls the original."""
    if getattr(cls.infer_batch,'endfield_wrapped',False):return
    original=cls.infer_batch
    def infer_batch(accel,*args,**kwargs):
        bound=getattr(_accel,'bound',None)
        if bound is not None and bound[0].t2s_accel is accel:bound[1].ensure()
        return original(accel,*args,**kwargs)
    infer_batch.endfield_wrapped=True;cls.infer_batch=infer_batch

class SegmentRecorder:
    """Wraps one TTS engine instance; one entry in `ready` per fragment the vocoder will emit, in order."""
    def __init__(self,engine,symbols,attention_module=None):
        """attention_module: callable returning the current MRTE cross-attention module."""
        self.symbols=symbols;self.ready=collections.deque();self.last=None;self.parts=[];self.captured=[]
        attention=None if attention_module is None else ModuleHook(attention_module,lambda module,inputs,output:self.captured.append(module.attn.detach().float().cpu()))
        pre=engine.text_preprocessor
        segment,phones_and_bert,clean=pre.segment_and_extract_feature_for_text,pre.get_phones_and_bert,pre.clean_text_inf
        vocoder=engine.using_vocoder_synthesis
        # get_phones_and_bert retries itself with "."+text for short input; resetting here keeps only the last attempt.
        def get_phones_and_bert(*args,**kwargs):
            self.parts=[];return phones_and_bert(*args,**kwargs)
        def clean_text_inf(*args,**kwargs):
            result=clean(*args,**kwargs);self.parts.append((args[1] if len(args)>1 else kwargs['language'],result));return result
        def segment_and_extract(*args,**kwargs):
            phones,bert,norm_text=segment(*args,**kwargs)
            self.last=None if phones is None else self.meta(phones,norm_text)
            return phones,bert,norm_text
        # Called once per sentence with that sentence's generated tokens [1,1,N] and target phones [1,P].
        def using_vocoder_synthesis(semantic_tokens,phones,*args,**kwargs):
            if self.last is None or phones[0].tolist()!=self.last['phone_ids']:raise ValueError('Vocoder phones differ from the last recorded text segment')
            entry={**self.last,'semantic_tokens':int(semantic_tokens.shape[-1])};self.captured.clear()
            if attention is not None:attention.ensure()
            result=vocoder(semantic_tokens,phones,*args,**kwargs)
            if attention_module is not None:
                # MRTE runs twice per fragment: reference prompt first, target sentence last.
                attn=self.captured[-1];shape=(1,4,2*entry['semantic_tokens'],len(entry['phone_ids']))
                if tuple(attn.shape)!=shape:raise ValueError(f'MRTE attention shape {tuple(attn.shape)} != {shape}')
                entry['attn']=attn[0].numpy()
            self.ready.append(entry)
            return result
        pre.get_phones_and_bert=get_phones_and_bert;pre.clean_text_inf=clean_text_inf
        pre.segment_and_extract_feature_for_text=segment_and_extract;engine.using_vocoder_synthesis=using_vocoder_synthesis
    def meta(self,phones,norm_text):
        """parts: one entry per language part, {lang, start, end (phone indices), word2ph, norm_text}."""
        ids=[i for _,part in self.parts for i in part[0]]
        if ids!=list(phones):raise ValueError('Recorded phone parts differ from the returned phones')
        word2ph=None if any(part[1] is None for _,part in self.parts) else [n for _,part in self.parts for n in part[1]]
        parts=[];pos=0
        for lang,(part_ids,part_word2ph,part_text) in self.parts:
            parts.append({'lang':lang,'start':pos,'end':pos+len(part_ids),'word2ph':part_word2ph,'norm_text':part_text});pos+=len(part_ids)
        return {'norm_text':norm_text,'phone_ids':ids,'phones':[self.symbols[i] for i in ids],'word2ph':word2ph,'parts':parts}
    def reset(self):
        self.ready.clear();self.last=None;self.parts=[]
    def take(self,samples,tail_samples):
        if not self.ready:raise ValueError('Fragment without a recorded text segment')
        meta=self.ready.popleft()
        if samples!=TOKEN_HOP_SAMPLES*meta['semantic_tokens']+tail_samples:raise ValueError('Fragment samples != 1920*tokens + tail')
        return meta

class C2Stream:
    def __init__(self,session_epoch,turn_id,speech_id,put=None):
        """put(event), when given, is called inside the lock that assigns seq, so output order equals seq order across threads."""
        self.ids={'session_epoch':session_epoch,'turn_id':turn_id,'speech_id':speech_id};self.seq=0;self.position=0;self.segments=0
        self.put=put;self.lock=threading.RLock()
    def event(self,kind,**fields):
        with self.lock:
            value={'event':kind,**self.ids,'seq':self.seq,**fields};self.seq+=1
            if self.put is not None:self.put(value)
            return value
    def begin(self,lang,engine,expires_at_ms,clause=None):
        """clause: clause_fields() result; given, the stream is v2 and carries those fields."""
        return self.event('speech.begin',schema=SCHEMA if clause is None else SCHEMA_V2,clock={'unit':'sample','sample_rate':48000,'origin':'first_pcm_sample'},format='pcm_s16le',channels=1,lang=lang,engine=engine,expires_at_ms=expires_at_ms,**(clause or {}))
    def fragment(self,pcm,samples,meta,tail_samples,generated_after_seconds):
        """pcm: little-endian int16 bytes of one fragment = speech + tail silence."""
        index=self.segments;n=meta['semantic_tokens']
        fields=dict(segment_index=index,norm_text=meta['norm_text'],phones=meta['phones'],start_sample=self.position,semantic_tokens=n,token_hop_samples=TOKEN_HOP_SAMPLES,speech_samples=TOKEN_HOP_SAMPLES*n,tail_silence_samples=tail_samples)
        if meta['word2ph'] is not None:fields['word2ph']=meta['word2ph']
        segment=self.event('segment',**fields)
        audio=self.event('audio',segment_index=index,start_sample=self.position,samples=samples,pcm_base64=base64.b64encode(pcm).decode('ascii'),generated_after_seconds=generated_after_seconds)
        self.position+=samples;self.segments+=1
        return [segment,audio]
    def complete(self,cues_complete=False,**extra):
        return self.event('complete',total_samples=self.position,segments=self.segments,cues_complete=cues_complete,**extra)
    def cues(self,index,revision,source,items):
        return self.event('cues',segment_index=index,revision=revision,source=source,items=items)
    def cancelled(self,reason,**extra):
        return self.event('cancelled',reason=reason,last_sample_sent=self.position,**extra)
