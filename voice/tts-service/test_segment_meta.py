"""Fake-engine tests for segment_meta; run: python3 -m unittest test_segment_meta (no torch needed)."""
import base64,json,pathlib,sys,unittest
HERE=pathlib.Path(__file__).resolve().parent
sys.path[:0]=[str(HERE),str(HERE.parents[1]/'protocol/C2-speech-stream')]
from segment_meta import C2Stream,SegmentRecorder,SCHEMA,SCHEMA_V2,CLAUSE_FIELDS,clause_fields
import validate

SYMBOLS=['_','.','n','i3','h','ao3','a','k','o','r','e','K','AO1']
TAIL=6400

class Tokens:
    def __init__(self,n):self.shape=(1,1,n)
class Phones:
    def __init__(self,ids):self.ids=ids
    def __getitem__(self,i):return self
    def tolist(self):return list(self.ids)

class FakePreprocessor:
    """Mirrors TextPreprocessor's call structure: segment -> get_phones_and_bert -> clean_text_inf per language part."""
    def __init__(self,table,parts):self.table=table;self.parts=parts
    def segment_and_extract_feature_for_text(self,text,language,version='v1'):
        return self.get_phones_and_bert(text,language,version)
    def get_phones_and_bert(self,text,language,version,final=False):
        if text=='':return None,None,None
        # Entries are a part text, or (part text, language) for a part another language segmenter picked out.
        parts=[self.clean_text_inf(*(t if isinstance(t,tuple) else (t,language)),version) for t in self.table[text]]
        phones=[i for p in parts for i in p[0]]
        if not final and len(phones)<6:return self.get_phones_and_bert('.'+text,language,version,final=True)
        return phones,'bert',''.join(p[2] for p in parts)
    def clean_text_inf(self,text,language,version='v2'):
        return self.parts[text]

class FakeEngine:
    def __init__(self,table,tokens):
        self.text_preprocessor=FakePreprocessor(table,PARTS);self.tokens=tokens;self.vocoded=[]
    def using_vocoder_synthesis(self,semantic_tokens,phones,speed=1.,sample_steps=32,cfg_rate=1.3):
        self.vocoded.append(phones.tolist());return semantic_tokens.shape[-1]
    def run(self,prompt,texts,phones_override=None):
        """Yields (sr, n_samples) per fragment like TTS.run with return_fragment and batch_size=1."""
        self.text_preprocessor.segment_and_extract_feature_for_text(prompt,'zh','v5dev')
        for text in texts:
            phones,_,_=self.text_preprocessor.segment_and_extract_feature_for_text(text,'zh','v5dev')
            if phones is None:continue
            n=self.using_vocoder_synthesis(Tokens(self.tokens[text]),Phones(phones_override or phones))
            yield 48000,TOKEN*n+TAIL
TOKEN=1920

ZH={'prompt':['你好你'],'你好':['你好'],'.你好':['.','你好'],'你好啊好':['你好啊好'],'kore':['kore'],'你好K':['你好',('K','en')]}
PARTS={'你好你':([2,3,4,5,2,3],[2,2,2],'你好你'),'你好':([2,3,4,5],[2,2],'你好'),'.':([1],[1],'.'),
       '你好啊好':([2,3,4,5,6,4,5],[2,2,1,2],'你好啊好'),'kore':([7,8,9,10,6,6],None,'kore'),'K':([11,12],None,'K')}

def stream(engine,texts,recorder):
    s=C2Stream('E1','T1','S1');lines=[s.begin('zh',{'gpt_sovits_commit':'1b47ca07','variant':'v5dev'},0)];recorder.reset()
    for sr,samples in engine.run('prompt',texts):
        meta=recorder.take(samples,TAIL);lines+=s.fragment(b'\0\0'*samples,samples,meta,TAIL,0.)
    lines.append(s.complete());return lines

class SegmentMetaTest(unittest.TestCase):
    def setUp(self):
        self.engine=FakeEngine(ZH,{'你好':20,'.你好':20,'你好啊好':31,'kore':12,'你好K':12})
        self.recorder=SegmentRecorder(self.engine,SYMBOLS)
    def test_stream_passes_validator_and_skips_empty_text(self):
        lines=stream(self.engine,['你好啊好','','你好'],self.recorder)
        self.assertIsNone(validate.check([json.dumps(l) for l in lines]))
        segments=[l for l in lines if l['event']=='segment']
        self.assertEqual([s['norm_text'] for s in segments],['你好啊好','.你好'])
        self.assertEqual(segments[0]['phones'],['n','i3','h','ao3','a','h','ao3'])
        self.assertEqual(segments[0]['word2ph'],[2,2,1,2])
        self.assertEqual(segments[1]['start_sample'],1920*31+TAIL)
        self.assertEqual([s['speech_samples'] for s in segments],[1920*31,1920*20])
    def test_short_text_retry_keeps_only_last_attempt(self):
        stream(self.engine,['你好'],self.recorder)
        self.assertEqual(self.engine.vocoded,[[1,2,3,4,5]])
    def test_word2ph_is_in_the_segment_when_it_is_put(self):
        sent=[];s=C2Stream('E1','T1','S1',put=lambda v:sent.append(json.dumps(v)));self.recorder.reset()
        for sr,samples in self.engine.run('prompt',['你好啊好']):s.fragment(b'\0\0'*samples,samples,self.recorder.take(samples,TAIL),TAIL,0.)
        self.assertEqual(json.loads(sent[0]).get('word2ph'),[2,2,1,2])
    def test_word2ph_omitted_without_mapping(self):
        lines=stream(self.engine,['kore'],self.recorder)
        segment=next(l for l in lines if l['event']=='segment')
        self.assertNotIn('word2ph',segment);self.assertEqual(segment['phones'],['k','o','r','e','a','a'])
    def test_parts_record_language_and_phone_range(self):
        self.recorder.reset();list(self.engine.run('prompt',['你好K']))
        meta=self.recorder.take(1920*12+TAIL,TAIL)
        self.assertEqual(meta['parts'],[{'lang':'zh','start':0,'end':4,'word2ph':[2,2],'norm_text':'你好'},{'lang':'en','start':4,'end':6,'word2ph':None,'norm_text':'K'}])
        self.assertIsNone(meta['word2ph'])
    def test_length_mismatch_is_rejected(self):
        self.recorder.reset();list(self.engine.run('prompt',['你好啊好']))
        with self.assertRaises(ValueError):self.recorder.take(1920*31+TAIL+1,TAIL)
    def test_vocoder_phones_must_match_recorded_text(self):
        self.recorder.reset()
        with self.assertRaises(ValueError):list(self.engine.run('prompt',['你好啊好'],phones_override=[2,3]))
    def test_fragment_without_recorded_segment_is_rejected(self):
        self.recorder.reset()
        with self.assertRaises(ValueError):self.recorder.take(1920*20+TAIL,TAIL)

CLAUSE={'utterance_id':'U1','clause_id':'C0','clause_index':0,'spoken_text_revision':1,'voice_profile_id':'voice_a.zh.default','interrupt_policy':'clause_end','turn_generation':0}
ENGINE={'gpt_sovits_commit':'1b47ca07','variant':'v5dev'}

class ClauseFieldsTest(unittest.TestCase):
    def body(self,**changes):return {'session_epoch':'E1','text':'你好',**CLAUSE,**changes}
    def test_all_valid_fields_come_back_unchanged(self):
        self.assertEqual(clause_fields(self.body()),CLAUSE);self.assertEqual(tuple(CLAUSE),CLAUSE_FIELDS)
    def test_no_fields_is_v1(self):
        self.assertIsNone(clause_fields({'session_epoch':'E1','text':'你好',**{k:None for k in CLAUSE_FIELDS}}))
        self.assertIsNone(clause_fields({'session_epoch':'E1'}))
    def test_missing_field_is_rejected(self):
        for name in CLAUSE_FIELDS:
            with self.subTest(name),self.assertRaises(ValueError):clause_fields(self.body(**{name:None}))
    def test_trace_id_is_echoed_on_v2_only(self):
        tid='3f1c2b9e-0d4a-4c1e-9b7a-2f6e5d4c3b2a'
        self.assertEqual(clause_fields(self.body(trace_id=tid)),{**CLAUSE,'trace_id':tid})
        self.assertIsNone(clause_fields({'session_epoch':'E1','trace_id':tid}))
        for bad in (7,'','x'*65):
            with self.subTest(bad),self.assertRaises(ValueError):clause_fields(self.body(trace_id=bad))
    def test_invalid_values_are_rejected(self):
        for change in [{'interrupt_policy':'later'},{'clause_index':-1},{'spoken_text_revision':0},{'turn_generation':-1},{'clause_id':'汉'*22},{'voice_profile_id':''}]:
            with self.subTest(change),self.assertRaises(ValueError):clause_fields(self.body(**change))
    def test_clause_id_without_utterance_id_is_rejected(self):
        with self.assertRaises(ValueError):clause_fields({'clause_id':'C0'})
    def test_begin_with_clause_is_v2(self):
        event=C2Stream('E1','T1','S1').begin('zh',ENGINE,0,clause=dict(CLAUSE))
        self.assertEqual(event['schema'],SCHEMA_V2);self.assertEqual({k:event[k] for k in CLAUSE_FIELDS},CLAUSE);self.assertEqual(event['engine'],ENGINE)
    def test_begin_without_clause_is_unchanged_v1(self):
        self.assertEqual(C2Stream('E1','T1','S1').begin('zh',ENGINE,0),{'event':'speech.begin','session_epoch':'E1','turn_id':'T1','speech_id':'S1','seq':0,'schema':SCHEMA,'clock':{'unit':'sample','sample_rate':48000,'origin':'first_pcm_sample'},'format':'pcm_s16le','channels':1,'lang':'zh','engine':ENGINE,'expires_at_ms':0})

class RequestModelTest(unittest.TestCase):
    """serve_tts's request models, taken from the source because serve_tts needs FastAPI and a token file to import."""
    def setUp(self):
        import ast,pydantic
        path=HERE/'serve_tts.py'
        nodes=[n for n in ast.parse(path.read_text()).body if isinstance(n,ast.ClassDef) and n.name in ('Request','SpeechRequest')]
        self.models={name:getattr(pydantic,name) for name in ('BaseModel','Field','field_validator')}
        exec(compile(ast.Module(nodes,[]),str(path),'exec'),self.models)
        self.ValidationError=pydantic.ValidationError
    def test_whitespace_only_text_is_rejected(self):
        speech={'session_epoch':'E1','turn_id':'T1','speech_id':'S1','expires_at_ms':0}
        for name,fields in (('Request',{}),('SpeechRequest',speech)):
            model=self.models[name]
            self.assertEqual(model(character='c',language='zh',text=' 你好 ',**fields).text,' 你好 ')
            for text in (' ','　\n\t'):
                with self.subTest(name,text=text),self.assertRaises(self.ValidationError):model(character='c',language='zh',text=text,**fields)

class C2ExamplesTest(unittest.TestCase):
    def test_producer_matches_shared_examples(self):
        paths=sorted((HERE.parents[1]/'protocol/C2-speech-stream/examples').glob('ok-*.ndjson'))
        self.assertTrue(paths)
        for path in paths:
            if path.name in ('ok-late-revision.ndjson','ok-v22-no-cues.ndjson'):
                # Two audio lines share one segment, or audio without a segment; fragment() always emits segment+audio.
                continue
            with self.subTest(example=path.name):
                expected=path.read_text(encoding='utf-8').splitlines()
                inputs=[json.loads(line) for line in expected];begin=inputs[0];sent=[]
                stream=C2Stream(begin['session_epoch'],begin['turn_id'],begin['speech_id'],put=lambda e:sent.append(json.dumps(e)))
                stream.begin(begin['lang'],begin['engine'],begin['expires_at_ms'],clause=clause_fields(begin))
                # Additive fields absent from examples: audio.generated_after_seconds, complete.result.
                for i,line in enumerate(inputs[1:],1):
                    if line['event']=='segment':
                        audio=inputs[i+1]
                        meta={k:line[k] for k in ('norm_text','phones','semantic_tokens')};meta['word2ph']=line.get('word2ph')
                        # Example PCM is a placeholder; keep its declared sample count.
                        stream.fragment(base64.b64decode(audio['pcm_base64']),audio['samples'],meta,line['tail_silence_samples'],0.)
                    elif line['event']=='cues':
                        stream.cues(line['segment_index'],line['revision'],line['source'],line['items'])
                    elif line['event']=='complete':
                        stream.complete(cues_complete=line['cues_complete'],result={})
                    elif line['event']=='cancelled':
                        stream.cancelled(line['reason'])
                self.assertEqual(len(sent),len(expected),path.name)
                for number,(actual,line) in enumerate(zip(sent,expected),1):
                    actual=json.loads(actual)
                    for key,value in json.loads(line).items():
                        self.assertIn(key,actual,f'{path.name}:{number}: missing {key}')
                        self.assertEqual(actual[key],value,f'{path.name}:{number}: {key}')
                self.assertIsNone(validate.check(sent),path.name)

if __name__=='__main__':unittest.main()
