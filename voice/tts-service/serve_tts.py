"""HTTP adapter for renderer clients. Audio timing is sample-clock RMS."""
import argparse,asyncio,base64,collections,contextlib,gc,json,os,pathlib,queue,subprocess,sys,threading,uuid
def parse_args(argv=None):
    parser=argparse.ArgumentParser()
    parser.add_argument('port',type=int,nargs='?',default=9888)
    parser.add_argument('--listen-address',default='127.0.0.1')
    return parser.parse_args(argv)
if __name__=='__main__':args=parse_args()
TOKEN_FILE=os.environ.get('AAC_TTS_TOKEN_FILE')
if not TOKEN_FILE:raise SystemExit('Set AAC_TTS_TOKEN_FILE to the TTS token file (mode 0600)')
import anyio
from fastapi import FastAPI,HTTPException
from fastapi.responses import FileResponse,StreamingResponse
from pydantic import BaseModel,Field,field_validator
from tts_runtime import REPO,ROOT,LexiconInstalled,Runtime
from model_residency import GpuAdmission,GpuBudgetUnavailable,ModelResidency,MAX_MODELS
from segment_meta import C2Stream,clause_fields
from cues import CueStream,MfaClient,load_vowel_map
from auth import TokenAuth,load_token
HERE=pathlib.Path(__file__).resolve().parent
def gpt_sovits_commit(source):
    """The 8-digit short commit checked out at source, 'unknown' when git cannot tell."""
    try:result=subprocess.run(['git','-C',str(source),'rev-parse','--short=8','HEAD'],capture_output=True,text=True,timeout=10)
    except (OSError,subprocess.SubprocessError):return 'unknown'
    return result.stdout.strip() if result.returncode==0 and result.stdout.strip() else 'unknown'
GPT_SOVITS_COMMIT=gpt_sovits_commit(REPO)
# Deployed flat next to this file, copied from protocol/C2-speech-stream/.
VOWEL_MAP=load_vowel_map(HERE/'phone-vowel-map.json')
# Streams already carry the PCM; per-request WAV/timing/metrics files under output/<run>/ are written only with AAC_TTS_KEEP_FILES=1 (debugging).
KEEP_FILES=os.environ.get('AAC_TTS_KEEP_FILES')=='1'
MFA=MfaClient([os.environ['AAC_MFA_PYTHON'],str(HERE/'mfa_worker.py')]) if os.environ.get('AAC_MFA_PYTHON') else None
app=FastAPI(title='Endfield local character TTS',version='0.2-pilot')
app.add_middleware(TokenAuth,token=load_token(TOKEN_FILE),remote_hosts=os.environ.get('AAC_TTS_REMOTE')=='1')
lock=threading.Lock();loaded=None;loaded_key=None;artifacts={}
def free_gpu_bytes():
    import torch
    return torch.cuda.mem_get_info()[0]
def clear_gpu_cache():
    import torch
    gc.collect();torch.cuda.empty_cache()
# The on-demand launcher supplies the shared reservation; manual local pilots still
# enforce single-model residency and the same conservative free-memory floor.
residency=ModelResidency(GpuAdmission(free_gpu_bytes,os.environ.get('AAC_TTS_GPU_JOB')),clear_gpu_cache)
resident=residency.models
class Request(BaseModel):
    character:str
    language:str
    text:str=Field(min_length=1,max_length=1500)
    allow_unvalidated_pilot:bool=False
    accelerated:bool=False
    reference_id:str|None=None
    model_profile:str|None=Field(default=None,pattern=r'^[a-z0-9_-]+$')
    @field_validator('text')
    @classmethod
    def text_has_speech(cls,text):
        if not text.strip():raise ValueError('text is only whitespace')
        return text
class SpeechRequest(Request):
    session_epoch:str
    turn_id:str
    speech_id:str
    expires_at_ms:int
    utterance_id:str|None=None
    clause_id:str|None=None
    clause_index:int|None=None
    spoken_text_revision:int|None=None
    voice_profile_id:str|None=None
    interrupt_policy:str|None=None
    turn_generation:int|None=None
    trace_id:str|None=None
def registry():
    path=ROOT/'state/tts-registry.json'
    return json.loads(path.read_text()) if path.exists() else {}
def resolve(request):
    key=request.character+':'+request.language+('@'+request.model_profile if request.model_profile else '')
    entry=registry().get(key)
    if not entry:raise HTTPException(409,'This character/language run is not ready.')
    if entry['quality_acceptance']!='passed' and not request.allow_unvalidated_pilot:raise HTTPException(409,'Pilot quality acceptance pending; explicitly allow the unvalidated pilot to preview it.')
    reference_id=request.reference_id if request.reference_id is not None else entry.get('default_reference_id')
    if reference_id is not None:
        path=ROOT/'data/adaptation-v1'/(entry['run']+'.json')
        if not path.exists():raise HTTPException(409,'Reference bank is not ready for this character and language.')
        bank=json.loads(path.read_text())
        if bank['run']!=entry['run'] or reference_id not in {r['id'] for r in bank['reference_bank']}:raise HTTPException(409,'Unknown reference for this character and language.')
    return entry
def load_entry(entry):
    global loaded,loaded_key
    key=(entry['run'],entry.get('game_lexicon',False))
    if loaded_key==key:return
    # Remove the public strong reference before eviction and collection.
    loaded=None;loaded_key=None;gc.unfreeze()
    try:
        loaded=residency.load(key,lambda:Runtime(key[0],game_lexicon=key[1]))
        loaded_key=key
    except GpuBudgetUnavailable as error:
        raise HTTPException(503,str(error)) from error
    except LexiconInstalled as error:
        raise HTTPException(409,str(error)) from error
    finally:
        gc.collect();gc.freeze()
@contextlib.contextmanager
def gpu():
    with lock:
        try:yield
        finally:
            # Objects a request leaves behind would otherwise make every later TTS.run gc.collect() slower again.
            gc.collect();gc.freeze()
def ndjson(worker,messages,cancelled):
    """Waits for messages off the event loop so a client disconnect cancels the response at once and sets cancelled."""
    def take():
        while not cancelled.is_set():
            try:return messages.get(timeout=.2)
            except queue.Empty:pass
    async def events():
        while (value:=await asyncio.to_thread(take)) is not None:yield json.dumps(value,ensure_ascii=False)+'\n'
    class Stream(StreamingResponse):
        async def __call__(self,scope,receive,send):
            thread=threading.Thread(target=worker,daemon=True)
            thread.start()
            try:await super().__call__(scope,receive,send)
            finally:
                cancelled.set()
                # Hold the request slot until synthesis has actually stopped.
                with anyio.CancelScope(shield=True):await anyio.to_thread.run_sync(thread.join)
    return Stream(events(),media_type='application/x-ndjson',headers={'Cache-Control':'no-store','X-Accel-Buffering':'no'})
def parameters(entry):
    values=entry.get('inference_parameters',{})
    assert set(values)<=set(['temperature','top_k','text_split_method','cfg_rate','sample_steps'])
    return values
def attach_artifact(result,artifact_id):
    if result['audio'] is None:return {**result,'id':artifact_id}
    artifacts[artifact_id]={'audio':result['audio'],'timing':result['timing']}
    return {**result,'id':artifact_id,'audio_url':'/artifacts/'+artifact_id+'/audio','timing_url':'/artifacts/'+artifact_id+'/timing'}
@app.get('/health')
def health():return {'status':'running','gpt_sovits_commit':GPT_SOVITS_COMMIT,'registry':registry(),'loaded':loaded_key,'resident_models':list(resident),'cache_max_models':MAX_MODELS,'timing_kind':'20ms_rms_envelope','exact_phoneme_timing':False,'true_token_streaming':False}
@app.post('/synthesize')
def synthesize(request:Request):
    global loaded,loaded_key
    entry=resolve(request)
    with gpu():
        load_entry(entry)
        artifact_id=uuid.uuid4().hex
        result=loaded.synthesize(request.text,'api-'+artifact_id,request.accelerated,reference_id=request.reference_id if request.reference_id is not None else entry.get('default_reference_id'),**parameters(entry))
        return attach_artifact(result,artifact_id)
@app.post('/synthesize_stream')
def synthesize_stream(request:Request):
    entry=resolve(request);messages=queue.Queue(maxsize=4);cancelled=threading.Event()
    def put(value):
        while not cancelled.is_set():
            try:messages.put(value,timeout=.2);return
            except queue.Full:pass
        raise RuntimeError('Client disconnected')
    def worker():
        position=0
        try:
            with gpu():
                load_entry(entry);artifact_id=uuid.uuid4().hex
                def fragment(sr,chunk,elapsed):
                    nonlocal position
                    put({'event':'audio','sample_rate':sr,'format':'pcm_s16le','start_sample':position,'samples':len(chunk),'generated_after_seconds':elapsed,'pcm_base64':base64.b64encode(chunk.astype('<i2',copy=False).tobytes()).decode('ascii')});position+=len(chunk)
                result=loaded.synthesize(request.text,'api-stream-'+artifact_id,request.accelerated,on_chunk=fragment,cancel=cancelled,keep_files=KEEP_FILES,reference_id=request.reference_id if request.reference_id is not None else entry.get('default_reference_id'),**parameters(entry))
                put({'event':'complete',**attach_artifact(result,artifact_id),'delivery':'sentence_fragments','true_token_streaming':False})
        except Exception as exc:
            import traceback;traceback.print_exc()
            if not cancelled.is_set():put({'event':'error','message':str(exc)})
        finally:
            if not cancelled.is_set():put(None)
    return ndjson(worker,messages,cancelled)
@app.post('/speech_stream')
def speech_stream(request:SpeechRequest):
    """C2 speech timeline (protocol/C2-speech-stream): speech.begin, then segment+audio+cues(revision 1) per sentence fragment; cues revision 2 as MFA replies arrive."""
    try:clause=clause_fields(request.model_dump())
    except ValueError as exc:raise HTTPException(422,str(exc))
    entry=resolve(request);messages=queue.Queue(maxsize=4);cancelled=threading.Event()
    def put(value):
        while not cancelled.is_set():
            try:messages.put(value,timeout=.2);return
            except queue.Full:pass
        raise RuntimeError('Client disconnected')
    stream=C2Stream(request.session_epoch,request.turn_id,request.speech_id,put=put)
    cues=CueStream(stream,request.language,VOWEL_MAP,MFA,cancelled)
    def worker():
        try:
            stream.begin(request.language,{'gpt_sovits_commit':GPT_SOVITS_COMMIT,'variant':'v5dev','run':entry['run']},request.expires_at_ms,clause=clause)
            with gpu():
                load_entry(entry);artifact_id=uuid.uuid4().hex;runtime=loaded
                def fragment(sr,chunk,elapsed):
                    meta=runtime.segments.take(len(chunk),runtime.tail_samples)
                    cues.fragment(chunk.astype('<i2',copy=False).tobytes(),len(chunk),meta,runtime.tail_samples,elapsed)
                result=runtime.synthesize(request.text,'api-speech-'+artifact_id,request.accelerated,on_chunk=fragment,cancel=cancelled,keep_files=KEEP_FILES,reference_id=request.reference_id if request.reference_id is not None else entry.get('default_reference_id'),**parameters(entry))
                if runtime.segments.ready:raise ValueError('Recorded text segments without audio')
                result=attach_artifact(result,artifact_id)
            cues.complete(result)
        except Exception as exc:
            import traceback;traceback.print_exc()
            if not cancelled.is_set():cues.end_cancelled('error',message=str(exc))
        finally:
            if not cancelled.is_set():put(None)
    return ndjson(worker,messages,cancelled)
@app.get('/artifacts/{artifact_id}/{kind}')
def artifact(artifact_id:str,kind:str):
    if artifact_id not in artifacts or kind not in ('audio','timing'):raise HTTPException(404)
    path=pathlib.Path(artifacts[artifact_id][kind])
    return FileResponse(path,media_type='audio/wav' if kind=='audio' else 'application/json')
if __name__=='__main__':
    import uvicorn
    uvicorn.run(app,host=args.listen_address,port=args.port)
