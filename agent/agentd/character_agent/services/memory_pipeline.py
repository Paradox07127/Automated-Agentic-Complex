"""Evidence-first automatic memory, using the selected role harness.

Keep task meaning instead of repeated app-name captions. Source quotes and
ownership are checked in code; inference never becomes user confirmation.
"""
import hashlib
import datetime
import json
import re
import threading
import time
import uuid

from brain.outbound import OutboundBlocked
from personal.episodes import _body
from personal.memory import TRUSTED, normalized_text
from character_agent.services.memory_service import ADD, DENY_WRITE

INSTRUCTIONS = '''Extract from sources the memories that will be useful later. The reader is the character days or weeks from now: it relies on projects to carry on the user's work and on memories to remember who the user is, what they like and what they agreed on with the character. Empty lines like "you are using some app" or "opened some page" are of no use to it.
projects keep the project's goal, constraints, decisions and their reasons, actual results, commits, test results, temporary paths, open issues and next steps; these are not copied into memories again. Write each project so whoever takes it over can continue directly, such as "the export endpoint now pages because a single request timed out; the paged version passes its tests, the front end is not wired yet", not "worked on the export". Leave fields without evidence empty.
memories hold only lasting content: stable personal facts, clear preferences, recurring habits and agreements. Tell lasting from one-off:
- Worth keeping: the user says "write code review comments in Chinese from now on" (preference); "we agreed to run the full tests before every release" (agreement).
- Not kept: what they had for lunch today, asking you to open the terminal this time, a window title, a one-off command or temporary path, a behavior seen once.
An observed habit can become a memory with kind=preference and authority=observed_context, such as "still writing code after 11 pm"; when it matches a habit in existing, use same_as and the system counts it across days. fact and experience do not need the user to say "remember"; a lasting fact backed by source text can be written; the work process itself still goes into the results, experience and context of projects.
Set scope=shared for general facts about the user's preferences, schedule, work, people and life. Set scope=character only for things between this character and the user: their nicknames, promises, private jokes, or private instructions about how she should treat them. Cite her conversation for a character memory.
Do not widen time ranges: one "Friday" cannot become "every Friday", and one agreement cannot become periodic, daily or a lasting habit; keep a period only when the source states it.
Trust goes in the authority field (asserted_by_user | observed_context | inferred_hypothesis), not in the text; the text states the content directly, with no notes like "maybe", "unverified" or "this is not a preference"; what you are unsure of is not written.
When sources contradict each other, recent outweighs old, and the user's own words beat the assistant's words and observations; when the user changes their mind, write the new version and do not point same_as at the old fact.
Do not record credentials such as passwords, tokens, keys, verification codes or ID numbers, nor other people's private matters. Do not guess personality, health or mood.
Return JSON: {"title":"concrete matter","summary":"informative complete summary",
"projects":[{"subject":"matter","goal":"goal","constraints":["constraint"],
"decisions":[{"decision":"decision","reason":"reason"}],"outcome":"result",
"unresolved":["open issue"],"next_steps":["next step"],"evidence":["source_id"]}],
"memories":[{"scope":"shared|character","kind":"fact|preference|experience|agreement","text":"complete knowledge","confidence":0.0,
"authority":"asserted_by_user|observed_context|inferred_hypothesis",
"evidence":[{"source_id":"source id","quote":"verbatim text from that source"}]}],
"no_new_knowledge":false}.
Projects and every memory cite ids from sources. A memory's quote is checked verbatim and a memory whose quote does not match is dropped: copy one continuous span from that source's original text as it is, without translating, rewording or joining; for preferences and agreements prefer the user's own words. confidence is the 0-1 confidence of the evidence.
When a new memory means the same as a fact in existing, return that fact_id in its same_as field; otherwise omit same_as.
When brief activity has no lasting value, return no_new_knowledge=true, projects=[], memories=[].
Otherwise title, summary and projects all need content, and each project gives at least one of goal, constraints, decisions, unresolved or next_steps, or the whole extraction is void; when there are only preferences or agreements, write the conversation they came up in as one matter in projects.'''


# 不是<称呼>的偏好: the card's user_title is any short word.
HEDGE = re.compile(r'不是[^，。；、\s]{1,8}?的?(偏好|授权|决定|证据)|不(能|足以)?(代表|证明)|仅为推断|未经(验证|证实)|证据(不足|有限)|not (evidence|a preference)|\b(?i:maybe|probably|might|I think|seems|not sure)\b')


RECURRENCE = {
    'daily': re.compile(r'每(?:天|日|晚|早)|\bdaily\b|\bevery\s+(?:day|night|morning)\b', re.I),
    'weekly': re.compile(r'每(?:个)?(?:周|星期)|\bweekly\b|\bevery\s+(?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b', re.I),
    'monthly': re.compile(r'每(?:个)?月|\bmonthly\b|\bevery\s+month\b', re.I),
    'yearly': re.compile(r'每年|\b(?:yearly|annually)\b|\bevery\s+year\b', re.I),
    'recurring': re.compile(r'定期|周期性|每隔|\b(?:regularly|periodically|recurring|recurrent)\b|\bevery\s+\d+\s+(?:days?|weeks?|months?)\b', re.I),
}


def recurrence_claims(text):
    claims=set()
    for period, pattern in RECURRENCE.items():
        for match in pattern.finditer(text):
            before=text[max(0,match.start()-12):match.start()]
            negated=bool(re.search(r'(?:不是|并非|而非|不要|不需要|无需|not|never)\s*$',before,re.I))
            claims.add((period,negated))
    return claims


def unsupported_recurrence(text, quotes):
    supported=set().union(*(recurrence_claims(quote) for quote in quotes))
    for period,negated in recurrence_claims(text):
        if (period,negated) in supported: continue
        if negated:
            # "Friday, not every Friday" narrows an ambiguous one-off; it
            # invents no recurring obligation. Do not reverse an explicit cycle.
            if (period,False) in supported or period=='recurring' and any(not polarity for _,polarity in supported): return True
        elif period!='recurring' or not any(not polarity for _,polarity in supported):
            return True
    return False


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def text_values(value):
    """Actual content strings, without JSON key names or escape sequences as evidence."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values(): yield from text_values(item)
    elif isinstance(value, list):
        for item in value: yield from text_values(item)


def asserted_user_quote(source, text, quote):
    message = source.get('user', '')
    return source.get('kind') == 'conversation' and text == quote and quote in message and (
        message.strip() == quote.strip() or bool(ADD.search(message)))


class MemoryPipeline:
    def __init__(self, controller, clock=time.time):
        self.controller, self.server, self.clock = controller, controller.server, clock
        self.lock = threading.Lock(); self.running = False; self.last = 0
        self.stopped = threading.Event()
        self.worker = None
        self.extract_lock = threading.Lock()
        self.retry_until = float(self.server.memory.setting('agent_memory_retry_until') or 0) if self.server.memory is not None else 0

    def start(self):
        if self.worker is not None: return
        def loop():
            while not self.stopped.is_set():
                self.tick(self.clock())
                self.stopped.wait(30)
        self.worker = threading.Thread(target=loop, name='personal-memory-maintenance', daemon=True)
        self.worker.start()

    def close(self):
        self.stopped.set()
        if self.worker: self.worker.join(timeout=1)

    def sources(self):
        s, c = self.server, self.controller
        cutoff = float(s.memory.setting('agent_memory_since') or 0)
        result = []
        knowledge = c.knowledge()
        if s.history:
            from personal.history import SELECT, COLUMNS
            cursor = int(s.memory.setting('agent_memory_history_cursor') or 0)
            # Ascending immutable row IDs survive restarts and arbitrary backlogs.
            # The cursor only passes unprocessed eligible rows in the commit below.
            after = cursor
            while len(result) < 12:
                with s.history.lock:
                    rows = s.history.db.execute(SELECT + ' WHERE id>? ORDER BY id LIMIT 200', (after,)).fetchall()
                if not rows: break
                for raw in rows:
                    row = dict(zip(COLUMNS, raw)); after = row['id']
                    if row['started_at'] < cutoff or row['source'] not in ('text','voice') or row['state'] not in ('completed','interrupted','cancelled') or not row['user_text']: continue
                    if DENY_WRITE.search(row['user_text']) or re.match(r'^\s*(?:请)?(?:忘记|删除.{0,12}记忆|更正.{0,12}记忆|forget\b)',row['user_text'],re.I): continue
                    item = {'source_id':'history:'+str(row['turn_id'] or row['id']), 'user':row['user_text'],
                        'character_id':row['character_id'], 'assistant':row['reply'] if row['state'] != 'cancelled' else '',
                        'at':row['started_at'], 'verified':False, 'kind':'conversation', 'requires':[], '_history_id':row['id']}
                    with s.memory.lock:
                        processed = s.memory.db.execute('SELECT version FROM agent_memory_processed WHERE source_id=?', (item['source_id'],)).fetchone()
                    try: version = digest({k:v for k,v in knowledge.sanitize(item, part='memory_source').items() if k not in ('at','_history_id')})
                    except OutboundBlocked: version = digest({k:v for k,v in item.items() if k not in ('at','_history_id')})  # settled below
                    if processed and processed[0] in ('forgotten', version, 'quarantined:'+version): continue
                    result.append(item)
                    if len(result) >= 12: break
                if len(rows) < 200: break
            if not result and after > cursor:
                s.memory.set_setting('agent_memory_history_cursor', str(after))
        if c.jobs:
            for job in reversed(c.jobs.store.results_since(cutoff)):
                if not job['payload']: continue
                scope = job['payload'].get('scope_id')
                if scope:
                    try: c.workspace.validate_scope(scope)
                    except ValueError: continue
                result.append({'source_id':'job:'+job['job_id'], 'user':job['payload']['user_request'],
                    'content':job['result'], 'at':job['updated_at'], 'verified':job['state']=='succeeded', 'kind':'role_task', 'requires':[], 'scope_id':scope})
        observations=getattr(c,'observations',None)
        if observations:
            for event in reversed(observations.events(cutoff)):
                result.append({'source_id':'observation:'+event['id'],'user':'','content':event,'at':event['at'],
                    'verified':False,'kind':'authorized_observation',
                    'requires':sorted({p for dep in event['dependencies'] for p in dep['requires']})})
        # Task hypotheses remain ephemeral context, never long-term extraction inputs.
        clean, blocked = [], {}
        for item in result:
            try: clean.append(knowledge.sanitize(item, part='memory_source'))
            # The guard blocks deterministically: settle that source alone so the batch and the history cursor move on.
            except OutboundBlocked: blocked[item['source_id']] = 'quarantined:'+digest({k:v for k,v in item.items() if k not in ('at','_history_id')})
        result = clean
        if not result and not blocked: return []
        with s.memory.lock:
            ids = [item['source_id'] for item in result]+list(blocked)
            processed = dict(s.memory.db.execute('SELECT source_id,version FROM agent_memory_processed WHERE source_id IN (' + ','.join('?' for _ in ids) + ')',ids))
            settle = [(k,v) for k,v in blocked.items() if processed.get(k) not in (v,'forgotten')]
            if settle: s.memory.db.executemany('INSERT OR REPLACE INTO agent_memory_processed VALUES(?,?)', settle); s.memory.db.commit()
        selected, size = [], 0
        for item in result:
            versioned={k:v for k,v in item.items() if k not in ('at','_history_id')}
            if item['kind']=='authorized_observation':
                # The counter is process-local; unchanged evidence must not be re-extracted after restart.
                content=dict(versioned['content'])
                content['dependencies']=[{k:v for k,v in dep.items() if k!='consent_epoch'} for dep in content.get('dependencies',[])]
                versioned={**versioned,'content':content}
            version = digest(versioned)
            if processed.get(item['source_id']) in (version,'forgotten','quarantined:'+version): continue
            # Stop at the first different owner so the committed cursor never skips her lines.
            if selected and selected[0].get('character_id', s.character) != item.get('character_id', s.character):
                break
            length = len(json.dumps(item, ensure_ascii=False))
            # A large source runs alone and stays complete in the request/log.
            if selected and (size + length > 40000 or len(selected) >= 12): break
            selected.append({**item,'version':version}); size += length
            if size >= 40000: break
        return selected

    def tick(self, now):
        if self.stopped.is_set(): return
        if self.server.memory.paused(): return
        with self.lock:
            if self.running or now < self.retry_until or now-self.last < 120: return
            self.running, self.last = True, now
        def work():
            try: self.run_once()
            except ValueError:
                pass  # The semantic journal records the failed run; retry on the next due beat.
            finally:
                with self.lock: self.running = False
        threading.Thread(target=work, name='role-memory', daemon=True).start()

    def run_once(self):
        if not self.extract_lock.acquire(blocking=False): return None
        try:
            if self.clock() < self.retry_until: return None
            return self._run_once()
        except ValueError as exc:
            if str(exc) == 'usage_cap':
                # UsageMeter quotas reset at local midnight, including DST changes.
                now = datetime.datetime.fromtimestamp(self.clock())
                self.retry_until = datetime.datetime.combine(now.date()+datetime.timedelta(days=1), datetime.time()).timestamp()
                self.server.memory.set_setting('agent_memory_retry_until', str(self.retry_until))
            raise
        finally: self.extract_lock.release()

    def _run_once(self):
        s, c = self.server, self.controller
        if self.stopped.is_set() or s.memory.paused() or s.resetting or s.closing: return None
        sources = self.sources()
        if not sources: return None
        epoch, history = s.memory.content_epoch, s.history_generation
        valid = lambda: s.memory.content_epoch == epoch and s.history_generation == history and not s.resetting and not s.closing and not self.stopped.is_set()
        findings = None
        def validate_output(value):
            nonlocal findings
            try: findings = self.validate(value, sources)
            # Finalize domain rejections after the harness has recorded its resolved model.
            except ValueError as exc: findings = exc
        text = '\n'.join(content for source in sources for content in text_values(
            [source.get('user',''), source.get('assistant',''), source.get('content',{})]))
        character_id = sources[0].get('character_id')
        existing = [fact for kind in ('fact','preference','experience','agreement') for fact in s.memory.similar(text, kind, character_id=character_id)]
        run = c.semantic.run('memory_extract', INSTRUCTIONS, {'sources':sources, 'existing':existing},
                             valid=valid, validate_output=validate_output, character_id=character_id)
        try:
            if isinstance(findings, ValueError): raise findings
            current = {r['source_id']:r['version'] for r in self.sources()}
            if not valid() or any(current.get(r['source_id']) != r['version'] for r in sources): raise ValueError('memory_sources_changed')
            return self.commit(run, sources, findings, valid)
        except ValueError as exc:
            run['journal'].record('validation', {'outcome':'rejected','code':str(exc)})
            run['journal'].outcome('rejected')
            self._quarantine(sources, str(exc))
            return {'run_id':run['run_id'],'state':'rejected','reason':str(exc)}
        except Exception:
            run['journal'].finish('failed')
            raise

    def _quarantine(self, sources, reason):
        if not sources or reason in ('memory_sources_changed', 'memory_sources_already_processed'): return
        memory = self.server.memory
        batch = digest([(r['source_id'], r['version']) for r in sources])
        prior = json.loads(memory.setting('agent_memory_rejection') or '{}')
        attempts = prior.get('attempts', 0)+1 if prior.get('batch') == batch else 1
        memory.set_setting('agent_memory_rejection', json.dumps({'batch':batch, 'attempts':attempts, 'reason':reason[:80]}))
        if attempts < 3: return
        with memory.lock:
            memory.db.executemany('INSERT OR REPLACE INTO agent_memory_processed VALUES(?,?)',
                [(r['source_id'], 'quarantined:'+r['version']) for r in sources])
            ids = [r['_history_id'] for r in sources if '_history_id' in r]
            if ids: memory.db.execute("INSERT OR REPLACE INTO memory_settings VALUES('agent_memory_history_cursor',?)", (str(max(ids)),))
            memory.db.commit()

    def validate(self, value, sources):
        by_id = {s['source_id']:s for s in sources}
        projects, proposed = value.get('projects'), value.get('memories')
        if type(value.get('no_new_knowledge')) is not bool: raise ValueError('invalid_memory_shape')
        if not isinstance(projects,list) or len(projects)>12 or not isinstance(proposed,list) or len(proposed)>16:
            raise ValueError('invalid_memory_shape')
        if value.get('no_new_knowledge') is True:
            if projects or proposed: raise ValueError('conflicting_memory_noop')
            return {'projects':[], 'accepted':[], 'rejected':[], 'noop':True}
        if not projects or not isinstance(value.get('title'),str) or not isinstance(value.get('summary'),str) or not value['title'].strip() or not value['summary'].strip():
            raise ValueError('insufficient_memory_information')
        for p in projects:
            if not isinstance(p,dict) or not isinstance(p.get('subject'),str) or not p['subject'].strip() or \
                    not isinstance(p.get('evidence'),list) or not p['evidence'] or any(not isinstance(i,str) or i not in by_id for i in p['evidence']):
                raise ValueError('invalid_project_evidence')
            if any(not isinstance(p.get(k,''),str) for k in ('goal','outcome')) or any(not isinstance(p.get(k,[]),list) or any(not isinstance(v,str) for v in p.get(k,[])) for k in ('constraints','unresolved','next_steps')) or not isinstance(p.get('decisions',[]),list):
                raise ValueError('invalid_project_shape')
            if any(not isinstance(d,dict) or any(not isinstance(d.get(k),str) for k in ('decision','reason')) for d in p.get('decisions',[])):
                raise ValueError('invalid_project_shape')
            if not any(p.get(k) for k in ('goal','constraints','decisions','unresolved','next_steps')):
                raise ValueError('insufficient_memory_information')
        accepted, rejected = [], []
        for item in proposed:
            reason, supports = None, []
            if not isinstance(item,dict) or item.get('scope') not in ('shared','character') or item.get('kind') not in ('fact','preference','experience','agreement') \
                    or not isinstance(item.get('text'),str) or not 2 <= len(item['text'].strip()) <= 2000:
                reason = 'invalid_memory_record'
            elif HEDGE.search(item['text']):
                reason = 'hedge_memory_text'
            else:
                refs = item.get('evidence')
                if not isinstance(refs,list) or len(refs)>8: refs = []
                for ref in refs[:8]:
                    source_id = ref.get('source_id') if isinstance(ref,dict) else None
                    src = by_id.get(source_id) if isinstance(source_id,str) else None
                    quote = ref.get('quote') if isinstance(ref,dict) else None
                    if not src or not isinstance(quote,str) or len(quote)<2 or not any(quote in content for content in text_values([src.get('user',''),src.get('assistant',''),src.get('content',{})])):
                        reason='unsupported_memory_quote'; break
                    supports.append((src,quote))
                if not supports and reason is None: reason = 'missing_memory_evidence'
                if reason is None and item['scope'] == 'character' and not any(src['kind'] == 'conversation' for src, _ in supports):
                    reason = 'missing_character_evidence'
                if reason is None and unsupported_recurrence(item['text'], [quote for _,quote in supports]):
                    reason = 'unsupported_memory_recurrence'
            if reason:
                rejected.append({'proposal':item,'reason':reason}); continue
            # Execution checks certify the task's declared checks, not an LLM's
            # interpretation of its result or a user preference inferred from it.
            user_assertion = any(asserted_user_quote(src,item['text'],quote) for src,quote in supports)
            observed = any(src.get('kind') == 'authorized_observation' for src,quote in supports)
            source = 'asserted_by_user' if user_assertion else 'observed_context' if observed else 'inferred_hypothesis'
            state = 'active' if user_assertion else 'candidate'
            confidence = item.get('confidence')
            confidence = confidence if type(confidence) in (int,float) and 0 <= confidence <= 1 else 0
            accepted.append({**item,'authority':source,'source':source,'state':state,'confidence':confidence})
        return {'projects':projects,'accepted':accepted,'rejected':rejected,'noop':False}

    def commit(self, run, sources, findings, valid):
        s, memory = self.server, self.server.memory
        with memory.lock:
            db = memory.db
            db.execute('BEGIN IMMEDIATE')
            try:
                if not valid(): raise ValueError('memory_sources_changed')
                if any(db.execute('SELECT version FROM agent_memory_processed WHERE source_id=?',(r['source_id'],)).fetchone() == (r['version'],) for r in sources):
                    raise ValueError('memory_sources_already_processed')
                episode = None
                if not findings['noop']:
                    projects = findings['projects']
                    requirements = sorted({r for item in sources for r in item.get('requires',[])})
                    scopes = sorted({item['scope_id'] for item in sources if item.get('scope_id')})
                    apps = list({item['content']['app'] for item in sources if item['kind']=='authorized_observation' and item['content'].get('app')})
                    titles = list({item['content']['title'] for item in sources if item['kind']=='authorized_observation' and item['content'].get('title')})
                    threads = [{**p,'requires':requirements, 'scope_ids':scopes, 'topic':p['subject'],'session':p['subject'],'status':'unknown',
                                'progress':p.get('outcome') or p.get('goal') or '', 'blocked':False} for p in projects]
                    title, summary = run['value']['title'], run['value']['summary']
                    start, end = min(p['at'] for p in sources), max(p['at'] for p in sources)+.001
                    body = _body(title, summary, threads, [])
                    values = (start,end,title,summary,json.dumps(threads,ensure_ascii=False),
                        json.dumps([q for p in projects for q in p.get('unresolved',[])],ensure_ascii=False),json.dumps(apps),'[]',
                        self.clock(),json.dumps(titles),int('typed_text' in requirements),'unknown','[]','[]',3,run['run_id'],0)
                    episode = db.execute('INSERT INTO episodes(start,end,title,description,threads,open_questions,apps,hosts,created_at,titles,typed,presence,user_actions,agent_actions,version,run_id,edited) VALUES('+','.join('?' for _ in values)+')',values).lastrowid
                    db.execute('INSERT INTO episodes_fts(rowid,body) VALUES(?,?)',(episode,body))
                commits = []
                for item in findings['accepted']:
                    text = item['text'].strip()
                    if memory._suppressed(text):
                        findings['rejected'].append({'proposal':item,'reason':'previously_forgotten'}); continue
                    owner = sources[0]['character_id'] if item['scope'] == 'character' else None
                    same_as = item.get('same_as')
                    old = db.execute("SELECT fact_id,version FROM facts WHERE fact_id=? AND kind=? AND owner IS ? AND state IN ('active','candidate')",
                                     (same_as,item['kind'],owner)).fetchone() if isinstance(same_as,str) else None
                    if old is None:
                        old = next((row for row in db.execute("SELECT fact_id,version,text,state FROM facts WHERE kind=? AND owner IS ? AND state IN ('active','candidate')", (item['kind'],owner))
                                    if normalized_text(row[2]) == normalized_text(text)), None)
                    evidence = [f'episode:{episode}@{time.strftime("%Y-%m-%d",time.localtime(self.clock()))}', 'agent_run:'+run['run_id']]
                    supported = {ref['source_id'] for ref in item['evidence']}
                    sightings = [src for src in sources if src['source_id'] in supported]
                    if old:
                        ident, version = old[:2]
                        memory._sight(ident, sightings, item['confidence'])
                        prior, trust = db.execute("SELECT evidence,source FROM facts WHERE fact_id=? AND state IN ('active','candidate')", (ident,)).fetchone()
                        # A batch episode is a deletion closure; a confirmed fact it only reinforced must not join it.
                        if trust in TRUSTED: evidence = [ref for ref in evidence if not ref.startswith('episode:')]
                        db.execute("UPDATE facts SET evidence=?,reinforcement=reinforcement+1,reinforced_at=? WHERE fact_id=? AND state IN ('active','candidate')",
                                   (json.dumps(list(dict.fromkeys(json.loads(prior)+evidence))), self.clock(), ident))
                    else:
                        ident, version = str(uuid.uuid4()), 1
                        memory._insert(ident,version,item['kind'],text,item['source'],json.dumps(evidence),None,state=item['state'],owner=owner)
                        memory._sight(ident, sightings, item['confidence'])
                    source, state = db.execute("SELECT source,state FROM facts WHERE fact_id=? AND state IN ('active','candidate')", (ident,)).fetchone()
                    commits.append({'fact_id':ident,'version':version,'text':text,'source':source,'state':state,'evidence':item['evidence']})
                for item in sources:
                    db.execute('INSERT OR REPLACE INTO agent_memory_processed VALUES(?,?)',(item['source_id'],item['version']))
                history_ids = [item['_history_id'] for item in sources if '_history_id' in item]
                if history_ids:
                    db.execute("INSERT OR REPLACE INTO memory_settings VALUES('agent_memory_history_cursor',?)", (str(max(history_ids)),))
                proposals = [{'proposal':{'operation':'add','text':item['text'],
                    'evidence_quote':'\n'.join(ref['quote'] for ref in item['evidence'])},
                    'receipt':{'outcome':'candidate' if item['state']=='candidate' else 'stored',
                        'fact_id':item['fact_id'],'version':item['version']}} for item in commits]
                outcome = run['journal'].commit_extraction({'episode_id':episode,'projects':findings['projects'],
                    'accepted':commits,'rejected':findings['rejected'],'no_new_knowledge':findings['noop']},proposals)
                if not valid(): raise ValueError('memory_sources_changed')
                db.commit(); memory.revision += bool(commits)
            except Exception:
                db.rollback(); raise
        s.feed.publish('memory',{'action':'extracted','run_id':run['run_id'],'count':len(commits)})
        return {'run_id':run['run_id'],'state':outcome,'episode_id':episode,'memories':commits,'rejected':findings['rejected']}
