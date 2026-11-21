"""Local v5 inference with explicit checkpoint identity and sample-clock envelope."""
import hashlib,json,os,pathlib,sys,time
import numpy as np
import soundfile as sf
import yaml
ROOT=pathlib.Path(os.environ.get('AAC_VOICE_ROOT','/srv/tts'));REPO=pathlib.Path(os.environ.get('AAC_GPT_SOVITS') or ROOT/'GPT-SoVITS')
os.chdir(REPO);os.environ['NLTK_DATA']=str(ROOT/'models/nltk_data');os.environ['version']='v5dev'
sys.path[:0]=[str(REPO/'GPT_SoVITS'),str(REPO)];sys.path.append(str(ROOT/'tools'))
import torch
torch.set_num_threads(8)
from TTS_infer_pack.TTS import TTS,TTS_Config
from segment_meta import ModuleHook,SegmentRecorder,bind_accel_hook,wrap_infer_batch
FRAGMENT_INTERVAL=0.2
class Cancelled(Exception):pass

class Runtime:
    def __init__(self,run_name,base=False,variant='v5dev',game_lexicon=False):
        self.run=ROOT/'runs'/run_name;assert self.run.parent==ROOT/'runs'
        self.manifest=json.loads((self.run/'manifest.json').read_text());self.base=base;self.variant=variant
        pre=REPO/'GPT_SoVITS/pretrained_models'
        self.output=self.run/'inference';self.output.mkdir(exist_ok=True)
        if base:
            s1=pre/'s1v3.ckpt';s2=pre/f'gsv-v5-pretrained/s2G{variant}.pth'
        else:
            assert variant=='v5dev','Only dev has been trained in these runs'
            evidence=json.loads((self.run/'gpt-weight-change.json').read_text())
            assert evidence['changed_tensors']>0,'GPT checkpoint has no verified effective training update'
            s2vals=[json.loads(x) for x in (self.run/'train/validation.jsonl').read_text().splitlines() if json.loads(x)['epoch']>0]
            e2=min(s2vals,key=lambda r:r['heldout_cfm_loss'])['epoch']
            s2=next((self.run/'weights_s2').glob('*_e'+str(e2)+'_*.pth'))
            s1cfg=yaml.safe_load((self.run/'s1.yaml').read_text())
            s1vals=[json.loads(x) for x in (pathlib.Path(s1cfg['output_dir'])/'validation.jsonl').read_text().splitlines()]
            e1=min(s1vals,key=lambda r:r['val_total_loss'])['epoch']
            s1=next(pathlib.Path(s1cfg['train']['half_weights_save_dir']).glob('*-e'+str(e1)+'.ckpt'))
        assert s1.exists() and s2.exists()
        s1sha=hashlib.sha256(s1.read_bytes()).hexdigest();s2sha=hashlib.sha256(s2.read_bytes()).hexdigest()
        if not base:
            proofpath=self.run/'selected-checkpoint-verification.json'
            proof=json.loads(proofpath.read_text()) if proofpath.exists() else {}
            if proof.get('gpt_sha256')!=s1sha or proof.get('sovits_sha256')!=s2sha:
                original=torch.load(pre/'s1v3.ckpt',map_location='cpu',weights_only=False)['weight']
                selected=torch.load(s1,map_location='cpu',weights_only=False)['weight']
                changed=sum(not torch.equal(selected[k],original[k]) for k in selected)
                from process_ckpt import load_sovits_new
                adapter=load_sovits_new(str(s2))['weight']
                lora_b=[v for k,v in adapter.items() if 'lora_B' in k]
                nonzero_b=sum(bool(v.count_nonzero()) for v in lora_b)
                assert changed>0 and lora_b and nonzero_b==len(lora_b),'Selected checkpoint has no verified effective update'
                proof={'gpt_checkpoint':str(s1),'gpt_sha256':s1sha,'gpt_changed_tensors':changed,'gpt_total_tensors':len(selected),'sovits_checkpoint':str(s2),'sovits_sha256':s2sha,'lora_b_nonzero_tensors':nonzero_b,'lora_b_total_tensors':len(lora_b)}
                proofpath.write_text(json.dumps(proof,indent=2));del original,selected,adapter,lora_b
        references=[json.loads(x) for x in (self.run/'train/source.jsonl').read_text().splitlines()]
        references=[r for r in references if 3<=r['duration']<=9]
        assert references
        self.reference=max(references,key=lambda r:r['review']['neutral_probability'])
        if self.manifest.get('parent_run'):
            parent=ROOT/'runs'/self.manifest['parent_run'];assert parent.parent==ROOT/'runs'
            oldrefs=[json.loads(x) for x in (parent/'train/source.jsonl').read_text().splitlines()]
            expected=max((r for r in oldrefs if 3<=r['duration']<=9),key=lambda r:r['review']['neutral_probability'])
            matches=[r for r in references if r['wav_sha256']==expected['wav_sha256']]
            assert len(matches)==1,'Comparison run must preserve the parent baseline reference'
            self.reference=matches[0]
        self.lang='zh' if self.reference['language']=='chinese' else 'ja'
        if game_lexicon:
            from frontend_lexicon import install,install_ja
            if self.lang=='zh':install()
            else:install_ja(ROOT)
        cfg={'custom':{'device':'cuda','is_half':True,'version':variant,'t2s_weights_path':str(s1),'vits_weights_path':str(s2),'cnhuhbert_base_path':str(pre/'chinese-hubert-base'),'bert_base_path':str(pre/'chinese-roberta-wwm-ext-large')}}
        configpath=self.output/('runtime-'+('base-'+variant if base else 'trained')+'.yaml');configpath.write_text(yaml.safe_dump(cfg))
        self.identity={'run':run_name,'mode':'untrained_base_reference' if base else 'fine_tuned_pilot','variant':variant,'gpt_checkpoint':str(s1),'gpt_checkpoint_sha256':s1sha,'sovits_checkpoint':str(s2),'sovits_checkpoint_sha256':s2sha,'reference':self.reference['wav'],'reference_sha256':self.reference['wav_sha256'],'quality_acceptance':'pending'}
        import frontend_lexicon
        self.identity['frontend_lexicon_sha256']=(frontend_lexicon.LEXICON_SHA256 if frontend_lexicon.installed else None) if self.lang=='zh' else (frontend_lexicon.JA_LEXICON_SHA256 if frontend_lexicon.ja_installed else None)
        start=time.perf_counter();self.engine=TTS(TTS_Config(str(configpath)));torch.cuda.synchronize();self.load_seconds=time.perf_counter()-start
        from text import symbols2
        self.segments=SegmentRecorder(self.engine,symbols2.symbols,attention_module=lambda:self.engine.vits_model.enc_p.mrte.cross_attention)
        # Checked before each T2S token's ar_predict_layer (both AR paths call it outside the CUDA graph, and each step waits for the GPU) and before each of the 32 CFM estimator steps. The CPU launches CFM steps ahead of the GPU, so steps already queued still run before the lock frees.
        self.cancel=None;self.cancel_hook=ModuleHook(lambda:self.engine.vits_model.cfm.estimator,self.check_cancel,pre=True)
        self.t2s_hook=ModuleHook(lambda:self.engine.t2s_model.model.ar_predict_layer,self.check_cancel,pre=True)
        # The accelerated decoder only exists once TTS.run creates t2s_accel, so this hook is ensured inside AccelInference.infer_batch.
        self.t2s_accel_hook=ModuleHook(lambda:self.engine.t2s_accel.decoder.ar_predict_layer,self.check_cancel,pre=True)
        # Silence appended per fragment is sized at the SoVITS rate, not the 48 kHz output rate.
        self.tail_samples=int(self.engine.configs.sampling_rate*FRAGMENT_INTERVAL)
    def check_cancel(self,module,args):
        if self.cancel is not None and self.cancel.is_set():raise Cancelled()
    def close(self):
        accel=getattr(self.engine,'t2s_accel',None)
        if accel is not None:accel.close()
    def resolve_reference(self,reference_id=None):
        if reference_id is None:return self.reference,None,None
        bankpath=ROOT/'data/adaptation-v1'/(self.run.name+'.json')
        bank=json.loads(bankpath.read_text());assert bank['run']==self.run.name
        matches=[r for r in bank['reference_bank'] if r['id']==reference_id]
        if len(matches)!=1:raise ValueError('Unknown reference for this character and language')
        ref=matches[0]
        assert ref['character']==self.reference['character'] and ref['language']==self.reference['language']
        assert ref['origin']=='frozen_training_split' and 3<=ref['acoustic']['duration_seconds']<=9
        assert hashlib.sha256(pathlib.Path(ref['wav']).read_bytes()).hexdigest()==ref['wav_sha256']
        return ref,reference_id,hashlib.sha256(bankpath.read_bytes()).hexdigest()
    def synthesize(self,text,output_name,accelerated=False,segments=True,sample_steps=None,cfg_rate=None,on_chunk=None,temperature=1.,top_k=15,text_split_method='cut5',reference_id=None,seed=20261017,cancel=None,keep_files=True):
        """cancel: threading.Event; once set, raises Cancelled at the next T2S token, CFM step or fragment.
        keep_files: write the WAV, timing and metrics files under the run's inference/; when False, result['audio'] and result['timing'] are None."""
        assert text.strip();assert pathlib.Path(output_name).name==output_name
        assert isinstance(seed,int) and not isinstance(seed,bool) and 0<=seed<2**32,'A reproducible unsigned 32-bit seed is required'
        reference,reference_id,banksha=self.resolve_reference(reference_id)
        steps=(32 if self.variant=='v5dev' else 4) if sample_steps is None else int(sample_steps)
        cfg=(1.30 if self.variant=='v5dev' else 0.) if cfg_rate is None else float(cfg_rate)
        assert 4<=steps<=64 and 0<=cfg<=2
        assert .1<=temperature<=1.5 and 1<=top_k<=50 and text_split_method in ['cut3','cut5']
        params={'text':text,'text_lang':self.lang,'ref_audio_path':reference['wav'],'prompt_text':reference['text'],'prompt_lang':self.lang,'top_k':15,'top_p':1.,'temperature':1.,'text_split_method':'cut5','batch_size':1,'split_bucket':False,'speed_factor':1.,'fragment_interval':FRAGMENT_INTERVAL,'seed':seed,'parallel_infer':True,'use_cuda_graph':accelerated,'use_flash_attention':accelerated,'sample_steps':32 if self.variant=='v5dev' else 4,'cfg_rate':1.30 if self.variant=='v5dev' else 0.,'return_fragment':segments,'streaming_mode':False}
        params.update(sample_steps=steps,cfg_rate=cfg,temperature=temperature,top_k=top_k,text_split_method=text_split_method)
        self.segments.reset();self.cancel=cancel;self.cancel_hook.ensure();self.t2s_hook.ensure()
        if accelerated:
            # Imported here, not at module load: GPT_SoVITS.Accel switches the asyncio event loop policy on import. The module name must match tools/acceleration.py, or this wraps a different class object.
            from GPT_SoVITS.Accel.adapter import AccelInference
            wrap_infer_batch(AccelInference)
        torch.cuda.reset_peak_memory_stats();torch.cuda.synchronize();start=time.perf_counter();first=None;chunks=[];chunk_timings=[];sr=None
        run=self.engine.run(params);bind_accel_hook(self.engine,self.t2s_accel_hook)
        try:
            for sr,chunk in run:
                # TTS.run catches Cancelled, yields a 16 kHz silence chunk and then reloads its models; closing the generator at that yield skips the reload.
                if cancel is not None and cancel.is_set():raise Cancelled()
                torch.cuda.synchronize();elapsed=time.perf_counter()-start
                if first is None:first=elapsed
                assert chunk.dtype==np.int16,'Official output PCM format changed; refuse ambiguous streaming bytes'
                if on_chunk is not None:on_chunk(sr,chunk,elapsed)
                chunks.append(chunk);chunk_timings.append({'generated_after_seconds':elapsed,'samples':len(chunk)})
        finally:self.cancel=None;bind_accel_hook(None,None);run.close()
        torch.cuda.synchronize();total=time.perf_counter()-start;assert chunks and sr
        audio=np.concatenate(chunks);assert len(audio)>0
        path=self.output/(output_name+'.wav')
        if keep_files:sf.write(path,audio,sr,subtype='PCM_16')
        values=audio.astype('float32')/(32768 if np.issubdtype(audio.dtype,np.integer) else 1)
        hop=int(sr*0.02);envelope=[]
        for pos in range(0,len(values),hop):
            end=min(pos+hop,len(values));rms=float(np.sqrt(np.mean(values[pos:end]**2)))
            envelope.append({'start_sample':pos,'end_sample':end,'rms':rms,'mouth_open':min(1.,rms/0.15)})
        timing={'kind':'20ms_rms_envelope','clock':'audio_samples','sample_rate':sr,'phoneme_alignment':None,'note':'Amplitude-based mouth animation only. No exact phoneme or word alignment implied.','events':envelope}
        timingpath=path.with_suffix('.timing.json')
        if keep_files:timingpath.write_text(json.dumps(timing))
        result={**self.identity,'reference':reference['wav'],'reference_sha256':reference['wav_sha256'],'reference_text':reference['text'],'reference_id':reference_id,'reference_bank_sha256':banksha,'emotion_acceptance':'pending','text':text,'audio':str(path) if keep_files else None,'audio_sha256':hashlib.sha256(path.read_bytes()).hexdigest() if keep_files else None,'timing':str(timingpath) if keep_files else None,'sample_rate':sr,'duration_seconds':len(audio)/sr,'model_load_seconds':self.load_seconds,'first_generated_segment_seconds':first,'synthesis_total_seconds':total,'rtf':total/(len(audio)/sr),'peak_cuda_allocated_bytes':torch.cuda.max_memory_allocated(),'chunks':chunk_timings,'acceleration_requested':accelerated,'true_token_streaming':False,'http_ttfa_seconds':None,'seed':seed}
        accel=getattr(self.engine,'t2s_accel',None)
        result.update(sample_steps=steps,cfg_rate=cfg,temperature=temperature,top_k=top_k,text_split_method=text_split_method,actual_ar_backend=getattr(accel,'backend',None),cuda_graph_enabled=bool(getattr(accel,'graph_enabled',False)),cuda_graph_failed=bool(getattr(accel,'graph_failed',False)))
        if keep_files:path.with_suffix('.metrics.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
        return result

if __name__=='__main__':
 import argparse
 p=argparse.ArgumentParser();p.add_argument('run');p.add_argument('--base',action='store_true');p.add_argument('--variant',default='v5dev');p.add_argument('--accelerated',action='store_true');p.add_argument('--text',required=True);p.add_argument('--name',default='unseen-smoke');p.add_argument('--seed',type=int,default=20261017);a=p.parse_args()
 runtime=Runtime(a.run,a.base,a.variant);print(json.dumps(runtime.synthesize(a.text,a.name,a.accelerated,seed=a.seed),ensure_ascii=False),flush=True)
