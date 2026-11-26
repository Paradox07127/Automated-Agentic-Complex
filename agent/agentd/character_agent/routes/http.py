"""Authenticated product endpoints; harnesses never receive the UI token."""
import re
from urllib.parse import parse_qs, unquote, urlparse

from character_agent.services.workspace import WorkspaceError, _check_spec_for_path
from character_agent.services.deliveries import DeliveryError
from character_agent.integration import KernelNotReady


TASK = re.compile(r"^/tasks/([^/]{1,128})/(continue|cancel)$")
SCOPE = re.compile(r"^/agent/scopes/([^/]{1,128})/revoke$")


def route(handler, method, path):
    task, scope = TASK.fullmatch(path), SCOPE.fullmatch(path)
    memory_run = re.fullmatch(r"/memory/runs/([A-Za-z0-9_-]{1,128})", path)
    goal = re.fullmatch(r'/agent/goals/([a-f0-9]{32})', path)
    interaction = re.fullmatch(r'/agent/interactions/([a-f0-9]{32})/(answer|dismiss|continue)', path)
    job = re.fullmatch(r'/agent/jobs/([a-f0-9]{32})(?:/(cancel|resume))?', path)
    run = re.fullmatch(r'/agent/runs/([A-Za-z0-9_-]{1,128})/cancel', path)
    run_items = re.fullmatch(r'/agent/runs/([A-Za-z0-9_-]{1,128})/items', path)
    canonical = re.fullmatch(r'/agent/tasks/([^/]{1,196})(?:/(steps|files|accept|reject))?', path)
    delivery = re.fullmatch(r'/agent/deliveries/(delivery-[a-f0-9]{32})(?:/(presented|viewed|opened))?', path)
    if path not in ("/character/runtime", "/character/capabilities", "/character/acp/agents", "/character/acp/install", "/character/login/start", "/character/login/cancel", "/character/login/logout", "/agent/scopes", "/agent/runs", "/memory/runs", '/agent/goals', '/agent/jobs', '/agent/interactions', '/agent/tasks', '/agent/deliveries', '/agent/artifacts/revert') and not interaction and not task and not scope and not memory_run and not goal and not job and not run and not run_items and not canonical and not delivery:
        return False
    h, server = handler, handler.server
    def reply(status, data):
        h.json(status, data)
        return True
    if not h.auth(server.ui_token):
        return reply(401, {"error": "unauthorized"})
    if server.resetting or server.closing:
        return reply(503, {"error": "resetting" if server.resetting else "shutting_down"})
    controller = server.character_agent
    if controller is None:
        return reply(503, {"error": "character_runtime_unavailable"})
    try:
        if canonical or delivery or path in ('/agent/tasks', '/agent/deliveries'):
            service = getattr(controller, 'deliveries', None)
            if service is None: return reply(503, {'error': 'delivery_store_unavailable'})
            ident = unquote(canonical[1]) if canonical else None
            if ident is not None and not re.fullmatch(r'(job|task):[A-Za-z0-9_-]{1,160}', ident):
                raise DeliveryError('invalid_canonical_task', 400)
            if method == 'GET':
                query = parse_qs(urlparse(h.path).query)
                if set(query) - {'cursor', 'limit', 'conversation_id', 'character_id'}: raise DeliveryError('invalid_query', 400)
                try: limit = int(query.get('limit', ['50'])[0])
                except ValueError: raise DeliveryError('invalid_limit', 400) from None
                options = {'cursor': query.get('cursor', [None])[0], 'limit': limit}
                filters = {key: query[key][0] for key in ('conversation_id', 'character_id') if key in query}
                if path == '/agent/tasks': return reply(200, service.tasks_page(**options, **filters))
                if path == '/agent/deliveries': return reply(200, service.list(**options, **filters))
                if canonical and canonical[2] == 'steps': return reply(200, service.steps(ident, language=controller.semantic.reply(), **options))
                if canonical and canonical[2] == 'files':
                    run_ids = service.task_runs(ident)
                    if run_ids is None: return reply(404, {'error': 'not_found'})
                    files = {}  # a later run's entry replaces an earlier run's for the same path
                    for run_id in run_ids:
                        for item in controller.workspace.run_files(run_id): files[item['path']] = {**item, 'run_id': run_id}
                    return reply(200, {'files': sorted(files.values(), key=lambda item: item['path'])})
                if canonical and canonical[2] is None:
                    value = service.task(ident)
                    return reply(200, {'task': value}) if value else reply(404, {'error': 'unknown_task'})
                return reply(405, {'error': 'method_not_allowed'})
            if method != 'POST': return reply(405, {'error': 'method_not_allowed'})
            body = h.body()
            if delivery and delivery[2] == 'opened':
                if not isinstance(body, dict) or set(body) != {'artifact_id'} or not isinstance(body['artifact_id'], str):
                    raise DeliveryError('invalid_delivery_payload', 400)
                return reply(200, {'delivery': service.opened(delivery[1], body['artifact_id'])})
            required = {'expected_revision', 'generation'} | ({'delivery_id'} if canonical else set())
            if not isinstance(body, dict) or set(body) != required: raise DeliveryError('invalid_delivery_payload', 400)
            options = {key: body[key] for key in ('expected_revision', 'generation')}
            if canonical and canonical[2] in ('accept', 'reject'):
                if not isinstance(body['delivery_id'], str): raise DeliveryError('invalid_delivery_payload', 400)
                return reply(200, service.decide(ident, body['delivery_id'], canonical[2], **options))
            if delivery and delivery[2] in ('presented', 'viewed'):
                return reply(200, {'delivery': service.receipt(delivery[1], delivery[2], **options)})
            return reply(405, {'error': 'method_not_allowed'})
        if method == "GET":
            if path == '/agent/interactions': return reply(200, {'requests': controller.interactions.list()})
            if path in ('/agent/goals', '/agent/jobs') or job:
                if controller.jobs is None: return reply(503, {'error': 'job_store_unavailable'})
                if job and job[2] is not None: return reply(405, {'error':'method_not_allowed'})
                controller._recover_jobs()
                if path == '/agent/goals': return reply(200, {'goals': controller.jobs.store.goals()})
                if path == '/agent/jobs': return reply(200, {'jobs': controller.jobs.store.list()})
                value = controller.jobs.store.get(job[1])
                return reply(200, value) if value else reply(404, {'error': 'not_found'})
            if path == "/character/capabilities":
                return reply(200, controller.public(discover=True)["capabilities"])
            if path == "/character/acp/agents":
                return reply(200, controller.acp_agents(refresh=parse_qs(urlparse(h.path).query).get("refresh") == ["1"]))
            if path == "/memory/runs" or memory_run:
                journal = controller.memory_journal
                if journal is None:
                    return reply(503, {"error": "no_memory"})
                if memory_run:
                    value = controller.memory_run_details(memory_run[1])
                    return reply(200, value) if value is not None else reply(404, {"error": "unknown_memory_run"})
                query = parse_qs(urlparse(h.path).query)
                try:
                    limit = int(query.get("limit", ["50"])[0])
                except ValueError:
                    raise ValueError("invalid_limit") from None
                if not 1 <= limit <= 100: raise ValueError('invalid_limit')
                return reply(200, {"runs": controller.list_memory_runs(limit)})
            if path == "/character/runtime":
                refresh = parse_qs(urlparse(h.path).query).get("refresh") == ["1"]
                value = controller.public(discover=refresh, wait=refresh)
                if not refresh:
                    # Cached discovery only; a cold cache stays empty instead of waiting on probes.
                    value["installed_runtimes"] = controller.installed_runtimes(wait=False)
                return reply(200, value)
            if path == "/agent/scopes":
                return reply(200, {"scopes": controller.workspace.list_scopes()})
            if path == "/agent/runs":
                query = parse_qs(urlparse(h.path).query)
                if set(query) - {'run_id'}: return reply(400, {'error': 'invalid_query'})
                if 'run_id' not in query: return reply(200, {"runs": controller.store.list()})
                runs = [controller.store.get(run_id) for run_id in dict.fromkeys(query['run_id'])]
                return reply(200, {"runs": [run for run in runs if run is not None]})
            if run_items:
                if controller.store.get(run_items[1]) is None:
                    return reply(404, {"error": "unknown_run"})
                return reply(200, {"items": controller.store.items(run_items[1])})
            return reply(405, {"error": "method_not_allowed"})
        body = h.body()
        if not isinstance(body, dict):
            return reply(400, {"error": "invalid_payload"})
        if run and method == 'POST':
            if set(body) != {'generation'} or type(body['generation']) is not int: raise ValueError('invalid_payload')
            return reply(*controller.cancel_run(run[1], body['generation']))
        if path.startswith("/character/login/") and method == "POST":
            return reply(200, controller.login(path.rsplit("/", 1)[1], body))
        if path == "/character/acp/install" and method == "POST":
            if set(body) != {"agent_id"} or not isinstance(body["agent_id"], str): raise ValueError("invalid_payload")
            return reply(200, controller.acp_install(body["agent_id"]))
        if interaction and method == 'POST':
            ident, action = interaction.groups()
            required = {'expected_version', 'answers'} if action == 'answer' else {'expected_version'}
            if set(body) != required or type(body.get('expected_version')) is not int: raise ValueError('invalid_interaction')
            if action == 'answer': return reply(200, controller.interactions.respond(ident, body['expected_version'], body['answers']))
            if action == 'continue':
                status, value = controller.continue_interaction(ident, body['expected_version'])
                return reply(status, value)
            card = controller.interactions.get(ident)
            controller.interactions.dismiss(ident, body['expected_version'])
            run = controller.store.get(card['run_id'])
            if card['kind'] == 'question' and run and run['state'] == 'waiting_user':
                controller.cancel_run(run['run_id'], run['generation'])
            return reply(200, {'dismissed': True})
        if method == 'POST' and (path in ('/agent/goals', '/agent/jobs') or goal or job):
            if controller.jobs is None: return reply(503, {'error': 'job_store_unavailable'})
            if path == '/agent/goals':
                if set(body) != {'title', 'objective'}: raise ValueError('invalid_goal')
                return reply(201, controller.jobs.store.create_goal(body['title'], body['objective']))
            if goal:
                if set(body) != {'expected_version', 'state'}: raise ValueError('invalid_goal_update')
                return reply(200, controller.update_goal(goal[1], body['expected_version'], body['state']))
            if path == '/agent/jobs':
                if set(body) - {'title', 'text', 'scope_id', 'expected_outputs', 'goal_id'} or not {'title', 'text'} <= set(body):
                    raise ValueError('invalid_job')
                validate_say(body)
                try:
                    value = controller.submit_job(body['title'], body['text'], body['text'],
                        body['scope_id'] if 'scope_id' in body else controller.settings.snapshot().get('scope_id'), goal_id=body.get('goal_id'),
                        expected_outputs=body.get('expected_outputs'))
                except KernelNotReady as error:
                    return reply(503, {'error': error.code, 'runtime': error.runtime})
                return reply(202, value)
            if job and job[2] == 'cancel':
                if body: raise ValueError('invalid_payload')
                return reply(202, {'job_id': job[1], 'cancelled': controller.jobs.cancel(job[1])})
            if job and job[2] == 'resume':
                if set(body) - {'text', 'use_current_backend'} or type(body.get('use_current_backend', False)) is not bool:
                    raise ValueError('invalid_payload')
                return reply(202, controller.resume_job(job[1], text=body.get('text', ''), use_current_backend=body.get('use_current_backend', False)))
            return reply(405, {'error': 'method_not_allowed'})
        if path == "/character/runtime" and method == "PUT":
            return reply(200, controller.configure(body))
        if path == "/agent/scopes" and method == "POST":
            if set(body) - {"roots", "output_root", "files"} or not {"roots", "files"} & set(body):
                return reply(400, {"error": "invalid_scope"})
            with server._write_lock:
                if server.resetting or server.closing:
                    return reply(503, {"error": "resetting" if server.resetting else "shutting_down"})
                value = controller.workspace.create_scope(**body)
            return reply(201, value)
        if path == "/agent/artifacts/revert" and method == "POST":
            if set(body) != {"run_id", "path", "expected_version"} or not isinstance(body["run_id"], str) \
                    or not isinstance(body["path"], str) or type(body["expected_version"]) is not int:
                return reply(400, {"error": "invalid_payload"})
            artifact = next((a for a in controller.workspace.run_artifacts(body["run_id"]) if a["path"] == body["path"]), None)
            if artifact is None:
                return reply(404, {"error": "unknown_artifact"})
            return reply(200, controller.workspace.revert_artifact(body["run_id"], body["path"], scope_id=artifact["scope_id"],
                                                                  expected_version=body["expected_version"]))
        if scope and method == "POST":
            controller.cancel("scope_revoked")
            controller.workspace.revoke_scope(scope[1])
            if getattr(controller, 'deliveries', None) is not None:
                controller.deliveries.revoke(scope_id=scope[1])
            return reply(200, {"revoked": True})
        if task and method == "POST":
            item = server.tasks.get(task[1]) if server.tasks else None
            if item is None or item["target"] != "character":
                return reply(404, {"error": "unknown_character_task"})
            if task[2] == "cancel":
                if body or item["state"] not in ("running", "returned", "verifying"):
                    return reply(409, {"error": "invalid_state"})
                if not controller.cancel_task(task[1]):
                    return reply(409, {"error": "task_not_active"})
                return reply(202, {"task_id": task[1], "cancellation_requested": True})
            if set(body) - {"text"} or not isinstance(body.get("text", ""), str) or len(body.get("text", "")) > 8000:
                return reply(400, {"error": "invalid_payload"})
            if controller.jobs:
                for background in controller.jobs.store.list(limit=None):
                    run = controller.store.get(background['run_id'])
                    if run and run.get('task_id') == task[1]:
                        # Keep the owning job. Do not move a background task into
                        # the foreground or leave its product status stale.
                        return reply(202, controller.resume_job(background['job_id'], text=body.get('text', '')))
            if controller.busy():
                return reply(409, {"error": "character_busy"})
            checkpoint = controller.store.load_checkpoint(task_id=task[1])
            if checkpoint is None:
                return reply(409, {"error": "checkpoint_missing"})
            code, data = server.say(body.get("text", "").strip() or "请继续这项任务，并检查结果。",
                scope_id=checkpoint["scope_id"], resume_run_id=checkpoint["run_id"])
            return reply(code, data)
        return reply(405, {"error": "method_not_allowed"})
    except DeliveryError as error:
        return reply(error.status, {'error': error.code})
    except (ValueError, WorkspaceError) as error:
        code = getattr(error, "code", str(error))
        code = code if code and all(c.isalnum() or c == "_" for c in code) else "invalid_payload"
        status = 409 if code in ("interaction_version_changed", "interaction_cancelled", "interaction_character_changed", "conversation_not_active", "character_busy") else 400
        return reply(status, {"error": code})
    except OSError:
        return reply(503, {"error": "runtime_storage_unavailable"})


def validate_say(body):
    for key in ("scope_id", "resume_run_id"):
        if body.get(key) is not None and (not isinstance(body[key], str) or not 1 <= len(body[key]) <= 128):
            raise ValueError("invalid_" + key)
    expected = body.get("expected_outputs")
    if expected is not None:
        if not isinstance(expected, dict) or set(expected) != {"artifacts"} or not isinstance(expected["artifacts"], list) \
                or not 1 <= len(expected["artifacts"]) <= 12:
            raise ValueError("invalid_expected_outputs")
        from character_agent.services.workspace import _relative
        for artifact in expected["artifacts"]:
            if not isinstance(artifact, dict) or set(artifact) - {"path", "checks"}:
                raise ValueError("invalid_expected_outputs")
            _relative(artifact.get("path"))
            _check_spec_for_path(artifact["path"],artifact.get("checks", {}))
    return {key: body.get(key) for key in ("scope_id", "expected_outputs", "resume_run_id")}
