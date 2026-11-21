"""/episodes and /summary/runs."""
import datetime
import json
import re
from urllib.parse import parse_qs, urlparse

from infra.store import checkpoint
from sessions import threads
from api.views import _iso, _episode_json, _thread_json

EPISODE_ID = re.compile(r"[0-9]{1,18}")
EDIT_TITLE_MAX = 120
EDIT_DESCRIPTION_MAX = 12000
DAY_THREADS = 6  # threads GET /episodes?date= lists at most
RUN_KINDS = ("memory_extract", "observation_interpret", "observation_vision", "user_vision", "proactive_decide", "facing_decide", "observation_brief", "review", "conversation")


class EpisodesMixin:
    def _episodes_day(self, day):
        """GET /episodes?date=:the episodes that start on day, only with page text consent, and the threads of
        the day's permitted session summaries."""
        episodes = self.server.episodes
        if episodes is None:
            return self._json(503, {"error": "no_episodes"})
        date = datetime.date.fromisoformat(day)
        controller = self.server.character_agent
        allowed = lambda row: controller._permitted('episodes',row) if controller else self.server.page_text_allowed()
        rows = [_episode_json(e) for e in episodes.day(date) if allowed(e)]
        if controller is None and not self.server.page_text_allowed():
            return self._json(200, {'date':day,'enabled':False,'episodes':[],'threads':[]})
        work = self.server.worklog
        summaries = [row for row in (work.sessions_on(day) if work is not None and controller else [])
                     if row["state"] == "completed" and controller._permitted("sessions", row)]
        merged = threads.merge(threads.summary_rows(summaries))[:DAY_THREADS]
        self._json(200, {"date": day, "enabled": True, "episodes": rows, "threads": [_thread_json(t) for t in merged]})

    def _episode_evidence(self, raw_id):
        """GET /episodes/<id>/evidence:the evidence the episode's memory run was given, while the run's
        detail is kept, and the run's receipt."""
        server = self.server
        if server.episodes is None:
            return self._json(503, {"error": "no_episodes"})
        episode = server.episodes.get(int(raw_id)) if EPISODE_ID.fullmatch(raw_id) else None
        if episode is None:
            return self._json(404, {"error": "unknown_episode"})
        if server.character_agent:
            controller = server.character_agent
            if not controller._permitted('episodes',episode): return self._json(403, {'error':'source_permission_revoked'})
            run = controller.memory_run_details(episode['run_id'])
            if not run or not run['detail']: return self._json(410, {'error':'evidence_expired'})
            request = json.loads(run['detail']['request'])
            sources = request.get('evidence',{}).get('evidence',{}).get('sources',[])
            by_id = {item['source_id']:item for item in sources}
            ids = list(dict.fromkeys(v for t in episode['threads'] for v in t.get('evidence',[])))
            lines = [{'n':n+1, 'tag':by_id[v]['kind'], 'text':json.dumps(by_id[v],ensure_ascii=False)} for n,v in enumerate(ids) if v in by_id]
            return self._json(200, {'header':['角色内核生成；用户原话、助手声明和检查证据分别标注。'], 'lines':lines,
                'run':{'backend':run['backend'],'model':run['model'],'attempt':1,
                    'duration_ms':round(((run['finished_at'] or run['started_at'])-run['started_at'])*1000),
                    'outcome':run['state'],'reasons':[]}})
        if not server.page_text_allowed(): return self._json(403, {'error':'page_text_off'})
        self._json(410, {"error": "evidence_expired"})

    def _episode_edit(self, raw_id):
        """PATCH /episodes/<id> {title, description}:the user's wording replaces the episode's; the change is
        kept in summary_corrections."""
        try:
            body = self._body()
        except ValueError:
            return self._json(400, {"error": "invalid_payload"})
        episodes = self.server.episodes
        if episodes is None:
            return self._json(503, {"error": "no_episodes"})
        if not EPISODE_ID.fullmatch(raw_id): return self._json(404, {'error':'unknown_episode'})
        current=episodes.get(int(raw_id))
        if current is None: return self._json(404, {'error':'unknown_episode'})
        controller=self.server.character_agent
        if not (controller._permitted('episodes',current) if controller else self.server.page_text_allowed()):
            return self._json(403, {'error':'source_permission_revoked' if controller else 'page_text_off'})
        title, description = (body.get("title"), body.get("description")) if isinstance(body, dict) else (None, None)
        title = title.strip() if isinstance(title, str) else ""
        description = description.strip() if isinstance(description, str) else ""
        if not 0 < len(title) <= EDIT_TITLE_MAX:
            return self._json(400, {"error": "invalid_title"})
        if not 0 < len(description) <= EDIT_DESCRIPTION_MAX:
            return self._json(400, {"error": "invalid_description"})
        episode = episodes.edit(int(raw_id), title, description)
        if episode is None:
            return self._json(404, {"error": "unknown_episode"})
        briefs = getattr(controller, 'observation_briefs', None)
        if briefs is not None: briefs.clear()
        self._json(200, {"episode": _episode_json(episode)})

    def _summary_runs(self, day):
        """GET /summary/runs?date=&kinds=:the receipts of the runs that started on day, newest first, without
        any input or output text."""
        kinds = parse_qs(urlparse(self.path).query).get("kinds", ["memory_extract"])[0].split(",")
        if any(kind not in RUN_KINDS for kind in kinds):
            return self._json(400, {"error": "invalid_kinds"})
        controller = self.server.character_agent
        if controller is None or controller.memory_journal is None:
            return self._json(503, {'error':'no_memory_journal'})
        start = datetime.datetime.combine(datetime.date.fromisoformat(day), datetime.time())
        runs = controller.memory_journal.index(start.timestamp(), (start+datetime.timedelta(days=1)).timestamp(), kinds)
        self._json(200, {"date": day, "runs": [{**run, **{key: None if run[key] is None else _iso(run[key])
                                                          for key in ("started_at", "span_start", "span_end")}}
                                               for run in runs]})

    def _episode_delete(self, episode_id):
        """DELETE /episodes/<id>:one episode, and the consolidated facts it is evidence of."""
        server = self.server
        if server.episodes is None:
            return self._json(503, {"error": "no_episodes"})
        if not server.episodes.delete([episode_id]):
            return self._json(404, {"error": "unknown_episode"})
        facts = server._forget_derived([episode_id])  # publishes memory deleted for each
        checkpoint(server.episodes)
        self._json(200, {"deleted": 1, "facts": len(facts)})
