"""T2S cancel checkpoint on ar_predict_layer against fake accelerated GPT-SoVITS engines; run: python3 -m unittest test_t2s_cancel (no torch needed)."""
import pathlib,queue,sys,threading,time,unittest
HERE=pathlib.Path(__file__).resolve().parent
sys.path[:0]=[str(HERE)]
from segment_meta import ModuleHook,bind_accel_hook,wrap_infer_batch

TOKENS=200
JOIN_SECONDS=2

class Cancelled(Exception):pass

class FakeLinear:
    """Stands in for ar_predict_layer: calls counts every call, including one a pre-hook stops."""
    def __init__(self):self.pre_hooks=[];self.calls=0
    def register_forward_pre_hook(self,hook):self.pre_hooks.append(hook)
    def __call__(self,x):
        self.calls+=1
        for hook in self.pre_hooks:hook(self,(x,))

class FakeDecoder:
    def __init__(self):self.ar_predict_layer=FakeLinear()

class Session:
    def __init__(self,tokens):self.tokens=tokens;self.steps=0;self.queue=queue.Queue()

class FakeT2SEngine:
    """T2SEngine + ModelRunner: the background thread binds waiting sessions, then calls ar_predict_layer once per bound session and step (runner.py:313-330); on an exception it settles only bound sessions (t2s_engine.py:284-288)."""
    def __init__(self,decoder,tts):
        self.decoder=decoder;self.tts=tts;self.pending=queue.SimpleQueue();self.waiting=[];self.bound=[];self.stop=threading.Event()
        threading.Thread(target=self.loop,daemon=True).start()
    def add_request(self,tokens):
        session=Session(tokens);self.pending.put(session);return session
    def decode_step(self):
        if self.waiting:
            self.tts.before_bind()
            self.bound+=self.waiting;self.waiting=[]
        finished=[]
        for session in self.bound:
            self.decoder.ar_predict_layer(session.steps);session.steps+=1;self.tts.on_step(self.decoder.ar_predict_layer.calls)
            if session.steps==session.tokens:finished.append(session)
        for session in finished:self.bound.remove(session)
        return finished
    def loop(self):
        while not self.stop.is_set():
            while not self.pending.empty():self.waiting.append(self.pending.get())
            if not self.bound and not self.waiting:
                time.sleep(.001);continue
            try:finished=self.decode_step()
            except Exception as error:
                for session in list(self.bound):
                    session.queue.put(error);self.bound.remove(session)
                continue
            for session in finished:session.queue.put(None)

class FakeAccelInference:
    """AccelInference: prepare() (re)builds the decoder; infer_batch waits on the session queue without a timeout and re-raises its exception (adapter.py:126-140)."""
    def __init__(self,tts):self.tts=tts;self.decoder=None;self.engine=None;self.stale=False
    def prepare(self):
        if self.decoder is None or self.stale:
            if self.engine is not None:self.engine.stop.set()
            self.decoder=FakeDecoder();self.engine=FakeT2SEngine(self.decoder,self.tts);self.stale=False
        return True
    def infer_batch(self,tokens):
        session=self.engine.add_request(tokens);error=session.queue.get()
        if error is not None:raise error
        return tokens

class FakeTTS:
    """TTS.run: t2s_accel is created on first use (TTS.py:1373-1382); on an exception it yields 16 kHz silence and only then reloads (TTS.py:1655-1666)."""
    def __init__(self):
        self.t2s_accel=None;self.reloads=0
        self.on_step=lambda calls:None;self.before_bind=lambda:None
    def run(self,tokens):
        try:
            if self.t2s_accel is None:self.t2s_accel=FakeAccelInference(self)
            self.t2s_accel.prepare()
            yield 48000,self.t2s_accel.infer_batch(tokens)
        except Exception:
            yield 16000,0
            self.reloads+=1
            raise

class FakeRuntime:
    """tts_runtime.Runtime: the same hook, cancel check and consuming loop as synthesize."""
    def __init__(self):
        self.engine=FakeTTS();self.cancel=None
        self.t2s_accel_hook=ModuleHook(lambda:self.engine.t2s_accel.decoder.ar_predict_layer,self.check_cancel,pre=True)
    def check_cancel(self,module,args):
        if self.cancel is not None and self.cancel.is_set():raise Cancelled()
    def synthesize(self,tokens,cancel):
        self.cancel=cancel;wrap_infer_batch(FakeAccelInference)
        run=self.engine.run(tokens);bind_accel_hook(self.engine,self.t2s_accel_hook);chunks=[]
        try:
            for sr,chunk in run:
                if cancel.is_set():raise Cancelled()
                chunks.append(chunk)
        finally:self.cancel=None;bind_accel_hook(None,None);run.close()
        return chunks

def start(runtime,tokens,cancel):
    outcome={}
    def target():
        try:outcome['chunks']=runtime.synthesize(tokens,cancel)
        except Exception as error:outcome['error']=error
    thread=threading.Thread(target=target,daemon=True);thread.start()
    return thread,outcome

class T2SCancelTest(unittest.TestCase):
    def test_cancel_at_token_k_stops_by_call_k_plus_1(self):
        for k in (1,5,50):
            runtime=FakeRuntime();cancel=threading.Event()
            runtime.engine.on_step=lambda calls,k=k:cancel.set() if calls==k else None
            thread,outcome=start(runtime,TOKENS,cancel);thread.join(JOIN_SECONDS)
            self.assertFalse(thread.is_alive())
            self.assertIsInstance(outcome.get('error'),Cancelled)
            self.assertLessEqual(runtime.engine.t2s_accel.decoder.ar_predict_layer.calls,k+1)
            runtime.engine.t2s_accel.engine.stop.set()
    def test_hook_follows_a_rebuilt_decoder_once(self):
        runtime=FakeRuntime();cancel=threading.Event()
        runtime.synthesize(3,cancel);wrapped=FakeAccelInference.infer_batch
        wrap_infer_batch(FakeAccelInference);self.assertIs(FakeAccelInference.infer_batch,wrapped)
        accel=runtime.engine.t2s_accel;first=accel.decoder.ar_predict_layer
        runtime.synthesize(3,cancel);self.assertEqual(len(first.pre_hooks),1)
        accel.stale=True;accel.prepare();accel.infer_batch(3)
        second=accel.decoder.ar_predict_layer;self.assertIsNot(second,first)
        self.assertEqual(len(second.pre_hooks),0)
        runtime.synthesize(3,cancel);runtime.synthesize(3,cancel)
        self.assertEqual(len(second.pre_hooks),1)
        accel.engine.stop.set()
    def test_cancelled_request_skips_the_reload_and_the_engine_is_reused(self):
        runtime=FakeRuntime();cancel=threading.Event();cancel.set()
        thread,outcome=start(runtime,TOKENS,cancel);thread.join(JOIN_SECONDS)
        self.assertFalse(thread.is_alive());self.assertIsInstance(outcome.get('error'),Cancelled)
        self.assertEqual(runtime.engine.reloads,0)
        accel=runtime.engine.t2s_accel;self.assertEqual(accel.decoder.ar_predict_layer.calls,1)
        self.assertEqual(runtime.synthesize(TOKENS,threading.Event()),[TOKENS])
        self.assertIs(runtime.engine.t2s_accel,accel);self.assertEqual(runtime.engine.reloads,0)
        accel.engine.stop.set()
    def test_raising_before_bind_hangs_the_request(self):
        runtime=FakeRuntime();cancel=threading.Event();cancel.set()
        runtime.engine.before_bind=lambda:runtime.check_cancel(None,())
        thread,outcome=start(runtime,TOKENS,cancel);thread.join(.5)
        self.assertTrue(thread.is_alive())
        engine=runtime.engine.t2s_accel.engine;engine.stop.set()
        for session in engine.waiting:session.queue.put(None)
        thread.join(JOIN_SECONDS);self.assertFalse(thread.is_alive())

if __name__=='__main__':unittest.main()
