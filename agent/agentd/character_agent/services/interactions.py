"""Product-owned questions and exact-call approvals, independent of vendor sessions."""
import hashlib
import json
import threading
import time
import uuid

from tool_gateway.policy import POLICY


def encoded(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,allow_nan=False)


ASK_TOOL = {'name':'ask_user','description':'Show the user a question card and end this turn; their answers arrive in a later turn '
    'and also appear in the main window\'s questions list. Use it when a tool call or task cannot go ahead without a fact only the user knows '
    '(a missing reminder date or time, which of several files or projects they mean, a choice between clearly different outcomes); in ordinary chat just ask in your reply. '
    'A tool that raises its own approval card needs no permission question first. Until the answer arrives, nothing is answered or approved.',
    'input_schema':{'type':'object','properties':{'questions':{'type':'array','minItems':1,'maxItems':3,
        'description':'One to three questions shown together on one card.',
        'items':{'type':'object','properties':{'id':{'type':'string','maxLength':100,'description':'Short key unique within this call, e.g. "date".'},
            'question':{'type':'string','maxLength':2000,'description':'The full question, written to the user in your own voice.'},
            'options':{'type':'array','maxItems':8,'description':'Optional quick answers the user can tap; they can still type their own.',
                'items':{'type':'object','properties':{'label':{'type':'string','maxLength':200,'description':'Short answer text.'},
                    'description':{'type':'string','maxLength':500,'description':'Optional one-line explanation of this option.'}},'required':['label'],'additionalProperties':False}}},
            'required':['id','question'],'additionalProperties':False}}},'required':['questions'],'additionalProperties':False}}
# The approval card's question by reply language code; None takes the Chinese one. Its option labels are keys the UI answers with.
APPROVAL_QUESTION = {'zh-Hans': '是否允许这一次操作？', 'en': 'Allow this operation this time?', 'ja': '今回のこの操作を許可しますか？'}
# The approval decision each option label answers with.
APPROVAL_LABELS = {'允许': 'allow', '本对话都允许': 'allow_session', '拒绝': 'deny'}


class InteractionService:
    def __init__(self, store, emit=lambda value:None, clock=time.time, wait_seconds=POLICY.window('exact_call'), resume=None, waiting=None):
        self.store,self.db,self.lock,self.emit,self.clock=store,store.db,store.lock,emit,clock
        self.wait_seconds=wait_seconds
        self.resume,self.waiting=resume,waiting
        self.live={};self.stopped=threading.Event()
        self.session_grants={}  # process-local: (conversation/turn owner, server, tool) -> catalog, configuration and approval
        with self.lock:
            self.db.execute('CREATE TABLE IF NOT EXISTS character_interactions('
                'request_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,'
                'revision INTEGER NOT NULL,data TEXT,answer TEXT,created_at REAL NOT NULL,expires_at REAL NOT NULL,'
                'conversation_id TEXT,generation INTEGER NOT NULL DEFAULT 0)')
            self.db.execute("UPDATE character_interactions SET state='expired',data=NULL WHERE kind='approval' AND state='pending'")
            self.db.execute("UPDATE character_interactions SET state='answered',revision=revision+1,generation=generation+1 WHERE state='resuming'")
            self.db.commit()

    def _get(self, ident):
        row=self.db.execute('SELECT * FROM character_interactions WHERE request_id=?',(ident,)).fetchone()
        if row is None:return None
        result=dict(row)
        for key in ('data','answer'):result[key]=json.loads(result[key]) if result[key] else None
        return result

    def get(self, ident):
        with self.lock:return self._get(ident)

    def list(self):
        with self.lock:
            now=self.clock()
            expired=[r[0] for r in self.db.execute("SELECT request_id FROM character_interactions WHERE kind='approval' AND expires_at<? AND state IN ('pending','answered')",(now,))]
            self.db.execute("UPDATE character_interactions SET state='expired',data=NULL WHERE kind='approval' AND expires_at<? AND state IN ('pending','answered')",(now,))
            self.db.execute("DELETE FROM character_interactions WHERE created_at<? AND state NOT IN ('pending','answered','resuming')",(self.clock()-48*3600,));self.db.commit()
            ids=[r[0] for r in self.db.execute("SELECT request_id FROM character_interactions WHERE state IN ('pending','answered','resuming') ORDER BY created_at DESC LIMIT 100")]
            rows = [self._get(ident) for ident in ids]
            for row in rows:
                if row['data'] and row['data'].get('preview') is not None:
                    row['data']['preview_text'] = json.dumps(row['data']['preview'], ensure_ascii=False, indent=2)
        for ident in expired:self.emit({'request_id':ident,'kind':'approval','state':'expired'})
        return rows

    def pending_questions(self, conversation_id):
        with self.lock:
            rows=self.db.execute("SELECT data FROM character_interactions WHERE kind='question' AND state='pending' AND conversation_id=? ORDER BY created_at",(conversation_id,)).fetchall()
        return [q['question'] for row in rows for q in json.loads(row[0])['questions']]

    def ask(self, run_id, questions, *, valid, character_id, scope_id=None, user_text='',job_id=None,
            kind='question',preview=None,dangerous=False,danger_rule=None,approval_answers=None):
        from character_agent.services.workspace import _validate_arguments
        _validate_arguments({'questions':questions},ASK_TOOL['input_schema'])
        if len({q['id'] for q in questions})!=len(questions) or any(not q['id'] or not q['question'].strip() for q in questions):
            raise ValueError('invalid_questions')
        if not valid() or self.stopped.is_set():raise ValueError('interaction_cancelled')
        ident=uuid.uuid4().hex;wake=threading.Event();now=self.clock()
        data={'questions':questions,'preview':preview,'character_id':character_id,'scope_id':scope_id,
              'user_text':user_text,'job_id':job_id}
        if kind=='approval':
            data.update(dangerous=dangerous,danger_rule=danger_rule,
                        approval_answers=approval_answers or ['allow','deny'])
        raw=encoded(data)
        if len(raw)>40000:raise ValueError('interaction_too_large')
        with self.lock:
            if not valid() or self.stopped.is_set(): raise ValueError("interaction_cancelled")
            run=self.store.get(run_id)
            # Zero denotes a question with no expiry.
            self.db.execute("INSERT INTO character_interactions(request_id,run_id,kind,state,revision,data,created_at,expires_at,conversation_id) "
                "VALUES(?,?,?,'pending',1,?,?,?,?)",
                (ident,run_id,kind,raw,now,now+self.wait_seconds if kind=='approval' else 0,run['conversation_id'] if run else None))
            self.db.commit()
            if kind=='approval':self.live[ident]=(wake,valid)
        if kind=='question' and self.waiting:self.waiting(run_id,job_id)
        self.emit({'request_id':ident,'kind':kind,'state':'pending'})
        if kind=='question':raise ValueError('interaction_pending')
        try:
            deadline=time.monotonic()+self.wait_seconds
            while not self.stopped.is_set() and valid():
                remaining=deadline-time.monotonic()
                if remaining<=0:break
                if not wake.wait(min(.5,remaining)):continue
                if self.stopped.is_set() or not valid():break
                row=self.get(ident)
                if not row or row['state']!='pending':
                    if row and row['state']=='answered':
                        with self.lock:
                            self.db.execute("UPDATE character_interactions SET state='delivered',data=NULL,answer=NULL WHERE request_id=? AND state='answered'",(ident,)); self.db.commit()
                        return {'request_id':ident,**row['answer']}
                    raise ValueError('interaction_cancelled')
            if self.stopped.is_set() or not valid():raise ValueError('interaction_cancelled')
            raise ValueError('interaction_pending' if kind=='question' else 'approval_expired')
        finally:
            with self.lock:
                self.live.pop(ident,None)
                if kind=='approval':
                    self.db.execute("UPDATE character_interactions SET state='expired',data=NULL,answer=NULL WHERE request_id=? AND state IN ('pending','answered')",(ident,));self.db.commit()

    def catalog_changed(self,server,catalog):
        """Revoke all tools pinned to an older catalog as soon as a source is discovered."""
        with self.lock:
            self.session_grants={key:value for key,value in self.session_grants.items()
                                 if key[1]!=server or value['catalog']==catalog}

    def approve(self,run_id,preview,*,language=None,**context):
        """language: the reply language code for the card's question."""
        digest=hashlib.sha256(encoded(preview).encode()).hexdigest()
        single_only=context.pop('single_only',False)
        question=APPROVAL_QUESTION.get(language,APPROVAL_QUESTION['zh-Hans'])
        if not context['valid']() or self.stopped.is_set():raise ValueError('approval_expired')
        if preview.get('server'):self.catalog_changed(preview['server'],preview.get('catalog_sha256'))
        with self.lock:
            run=self.store.get(run_id)
            owner=('conversation',run['conversation_id']) if run and run['conversation_id'] else ('run',run_id)
            key=(owner,preview.get('server'),preview.get('tool'))
            catalog=preview.get('catalog_sha256')
            offered=bool(preview.get('tool')) and (not preview.get('server') or bool(catalog)) \
                and not (context.get('dangerous') or context.get('danger_rule') or single_only)
            grant=self.session_grants.get(key)
            # Any saved extension change may swap the endpoint, credentials or executable behind the same id.
            if grant and grant['configuration']!=preview.get('configuration_revision'):grant=None
        if offered and grant:
            if not context['valid']() or self.stopped.is_set():raise ValueError('approval_expired')
            self.emit({'request_id':grant['request_id'],'kind':'approval','state':'allowed_session',
                       'session_allowed':True,'conversation_id':run['conversation_id'] if run else None,
                       'run_id':run_id,'tool':preview['tool'],'server':preview.get('server'),'at':self.clock()})
            return {'request_id':grant['request_id'],'input_sha256':digest,'session_allowed':True}
        answers=['allow','allow_session','deny'] if offered else ['allow','deny']
        result=self.ask(run_id,[{'id':'decision','question':question,
            'options':[{'label':'允许'},*([{'label':'本对话都允许'}] if offered else []),{'label':'拒绝'}]}],
            kind='approval',preview=preview,approval_answers=answers,**context)
        decision=[APPROVAL_LABELS.get(a,a) for a in result['answers']['decision']]
        if decision not in (['allow'],['allow_session']):raise ValueError('approval_denied')
        if not context['valid']():raise ValueError('approval_expired')
        if decision==['allow_session']:
            with self.lock:
                if not offered or not context['valid']() or self.stopped.is_set():raise ValueError('approval_expired')
                self.session_grants[key]={'catalog':catalog,'configuration':preview.get('configuration_revision'),
                                         'request_id':result['request_id']}
        return {'request_id':result['request_id'],'input_sha256':digest}

    def respond(self,ident,revision,answers):
        return self.resume_answer(self.record_answer(ident,revision,answers))

    def record_answer(self,ident,revision,answers):
        row=self.get(ident)
        if not row or row['state']!='pending' or row['revision']!=revision:raise ValueError('interaction_version_changed')
        with self.lock:live=self.live.get(ident)
        if row['kind']=='approval' and (row['expires_at']<=self.clock() or not live or not live[1]()):
            raise ValueError('approval_expired')
        ids={q['id'] for q in row['data']['questions']}
        if not isinstance(answers,dict) or set(answers)!=ids or any(not isinstance(v,list) or not 1<=len(v)<=8 or
                any(not isinstance(s,str) or not 1<=len(s.strip())<=4000 for s in v) for v in answers.values()):
            raise ValueError('invalid_answers')
        if row['kind']=='approval':
            decision=APPROVAL_LABELS.get(answers['decision'][0],answers['decision'][0])
            if len(answers['decision'])!=1 or decision not in row['data'].get('approval_answers',['allow','deny']) \
                    or decision=='allow_session' and (row['data'].get('dangerous') or row['data'].get('danger_rule')):
                raise ValueError('invalid_approval')
        with self.lock:
            changed=self.db.execute("UPDATE character_interactions SET state='answered',revision=revision+1,generation=generation+1,answer=? WHERE request_id=? AND revision=? AND state='pending'",
                (encoded({'answers':answers}),ident,revision)).rowcount
            self.db.commit()
            receipt = self._get(ident) if changed else None
        if not changed:raise ValueError('interaction_version_changed')
        if live:live[0].set()
        self.emit({'request_id':ident,'kind':row['kind'],'state':'answered'})
        return {**receipt,'resume_required':not bool(live)}

    def resume_answer(self, receipt):
        ident = receipt['request_id']
        if receipt['kind']=='question' and self.resume:
            try:
                self.resume(ident, receipt['revision'])
            except ValueError as error:
                if str(error) != 'character_busy':
                    raise
                # The answer is committed. A different active turn delays continuation,
                # so acknowledge it and leave the explicit Continue action available.
                result = self.get(ident) or receipt
                return {**result, 'answer':receipt['answer'], 'resume_required':True, 'resume_reason':str(error)}
            result = self.get(ident) or receipt
            return {**result, 'answer': receipt['answer'], 'resume_required': result['state']=='answered'}
        return receipt

    def claim(self, ident, revision):
        with self.lock:
            row = self._get(ident)
            if not row or row['kind'] != 'question' or row['state'] != 'answered' or row['revision'] != revision:
                raise ValueError('interaction_version_changed')
            if ident in self.live: raise ValueError('interaction_still_running')
            self.db.execute("UPDATE character_interactions SET state='resuming',revision=revision+1,generation=generation+1 WHERE request_id=?", (ident,))
            self.db.commit()
            return row

    def settle(self, ident, dispatched):
        with self.lock:
            self.db.execute("UPDATE character_interactions SET state=?,revision=revision+1,generation=generation+1 WHERE request_id=? AND state='resuming'",
                            ('resumed' if dispatched else 'answered', ident)); self.db.commit()

    def dismiss(self,ident,revision):
        with self.lock:
            row=self.db.execute('SELECT kind FROM character_interactions WHERE request_id=?',(ident,)).fetchone()
            changed=self.db.execute("UPDATE character_interactions SET state='dismissed',revision=revision+1,generation=generation+1,data=NULL,answer=NULL WHERE request_id=? AND revision=? AND state IN ('pending','answered')",(ident,revision)).rowcount
            self.db.commit();live=self.live.get(ident)
        if not changed:raise ValueError('interaction_version_changed')
        if live:live[0].set()
        self.emit({'request_id':ident,'kind':row['kind'],'state':'dismissed'})

    def invalidate(self, *, run_ids=None):
        with self.lock:
            if run_ids is None:self.session_grants.clear()
            else:
                owners=set()
                for run_id in run_ids:
                    run=self.store.get(run_id)
                    owners.add(('conversation',run['conversation_id']) if run and run['conversation_id'] else ('run',run_id))
                self.session_grants={key:value for key,value in self.session_grants.items() if key[0] not in owners}
            if run_ids is None:
                rows=list(self.db.execute('SELECT request_id,kind FROM character_interactions'))
                self.db.execute('DELETE FROM character_interactions')
            else:
                rows=[]
                for run_id in run_ids:
                    rows.extend(self.db.execute('SELECT request_id,kind FROM character_interactions WHERE run_id=?',(run_id,)))
                    self.db.execute('DELETE FROM character_interactions WHERE run_id=?',(run_id,))
            self.db.commit();events=[self.live[r[0]][0] for r in rows if r[0] in self.live]
        for event in events:event.set()
        for ident,kind in rows:self.emit({'request_id':ident,'kind':kind,'state':'invalidated'})

    def close(self):
        self.stopped.set()
        with self.lock:
            self.session_grants.clear()
            events=[e[0] for e in self.live.values()]
        for event in events:event.set()


class QuestionTurn:
    """ask_user for one run, answered through the interaction inbox."""
    def __init__(self, interactions, interactive, run_id, character_id, text, scope_id, job_id=None):
        self.interactions, self.interactive, self.run_id = interactions, interactive, run_id
        self.context = dict(character_id=character_id, user_text=text, scope_id=scope_id, job_id=job_id)
        self.valid = lambda: False

    def open(self, valid):
        self.valid = valid

    def tool_definitions(self):
        return [ASK_TOOL] if self.interactive else []

    def call(self, name, args, call_id=None):
        from character_agent.services.workspace import WorkspaceError
        try:
            return self.interactions.ask(self.run_id, args['questions'], valid=self.valid, **self.context)
        except ValueError as error:
            raise WorkspaceError(str(error)) from None


def native_questions(questions):
    """Normalize vendor question cards, retaining opaque IDs for the response mapping."""
    if not isinstance(questions, list) or not 1 <= len(questions) <= 3:
        raise ValueError('invalid_questions')
    normalized = []
    for index, q in enumerate(questions):
        if not isinstance(q, dict): raise ValueError('invalid_questions')
        options = q.get('options') or []
        normalized.append({'id': str(q.get('id', index)), 'question': q.get('question', ''),
            'options': [{'label': o['label'], **({'description': o['description']} if o.get('description') else {})} for o in options]})
    from character_agent.services.workspace import _validate_arguments
    _validate_arguments({'questions': normalized}, ASK_TOOL['input_schema'])
    return normalized


def tool_answers(result):
    if result.get('isError'): raise ValueError('interaction_unavailable')
    for item in result.get('content', []):
        if item.get('type') == 'text':
            data = json.loads(item['text'])
            if isinstance(data, dict) and isinstance(data.get('answers'), dict): return data['answers']
    raise ValueError('interaction_unavailable')
