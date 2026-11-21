"""The DDL of the character_agent tables in agentd's shared store; store and each owner module read it here."""

DELIVERY_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS personal_job_runs (job_id TEXT NOT NULL, run_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,"
    " conversation_id TEXT, character_id TEXT, source_run_id TEXT, created_at REAL NOT NULL, first_event_seq INTEGER NOT NULL DEFAULT 0)",
    "CREATE INDEX IF NOT EXISTS personal_job_runs_job ON personal_job_runs(job_id,generation)",
    "CREATE TABLE IF NOT EXISTS personal_deliveries (delivery_id TEXT PRIMARY KEY, canonical_task_id TEXT NOT NULL,"
    " run_id TEXT NOT NULL UNIQUE, task_id TEXT, job_id TEXT, goal_id TEXT, conversation_id TEXT, character_id TEXT NOT NULL,"
    " source_run_id TEXT, parent_run_id TEXT, scope_id TEXT, generation INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,"
    " state TEXT NOT NULL, outcome TEXT NOT NULL, verification_source TEXT NOT NULL, decision_source TEXT,"
    " title TEXT NOT NULL, payload TEXT NOT NULL, produced_at REAL NOT NULL, presented_at REAL, viewed_at REAL, decided_at REAL,"
    " redacted INTEGER NOT NULL DEFAULT 0, schema_version INTEGER NOT NULL DEFAULT 1,"
    " delivery_version INTEGER NOT NULL DEFAULT 0)",
    "CREATE INDEX IF NOT EXISTS personal_deliveries_owner ON personal_deliveries(conversation_id,produced_at)",
    "CREATE TABLE IF NOT EXISTS personal_delivery_events (delivery_id TEXT NOT NULL, revision INTEGER NOT NULL,"
    " state TEXT NOT NULL, at REAL NOT NULL, actor TEXT NOT NULL, PRIMARY KEY(delivery_id,revision))",
)


def ensure_delivery_schema(db):
    for statement in DELIVERY_SCHEMA:
        db.execute(statement)
    db.execute('CREATE UNIQUE INDEX IF NOT EXISTS personal_delivery_version ON personal_deliveries(canonical_task_id,delivery_version)')


OBSERVATION_BRIEF_SCHEMA = (
    'CREATE TABLE IF NOT EXISTS observation_briefs (id TEXT PRIMARY KEY, character_id TEXT NOT NULL, period TEXT NOT NULL, date TEXT NOT NULL, timezone TEXT NOT NULL, start REAL NOT NULL, end REAL NOT NULL, updated_at REAL NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL, body TEXT, dependencies TEXT, consent_epoch INTEGER NOT NULL)',
    'CREATE INDEX IF NOT EXISTS observation_briefs_character ON observation_briefs(character_id,updated_at)',
    'CREATE INDEX IF NOT EXISTS observation_briefs_expiry ON observation_briefs(updated_at)',
    'CREATE TABLE IF NOT EXISTS observation_brief_failures (brief_id TEXT PRIMARY KEY, code TEXT NOT NULL, validation_path TEXT, at REAL NOT NULL)',
    'CREATE INDEX IF NOT EXISTS episodes_brief_window ON episodes(start,id)',
)

CONTINUOUS_OBSERVATION_SCHEMA = (
    'CREATE TABLE IF NOT EXISTS observation_content (hash TEXT PRIMARY KEY,text TEXT NOT NULL,image BLOB,created_at REAL NOT NULL)',
    # created_at sits after the image in the table row.
    'CREATE INDEX IF NOT EXISTS observation_content_created ON observation_content(hash,created_at)',
    # Content still holding a screenshot or text, oldest first, for the retention tiers.
    'CREATE INDEX IF NOT EXISTS observation_content_image ON observation_content(created_at,hash) WHERE image IS NOT NULL',
    "CREATE INDEX IF NOT EXISTS observation_content_text ON observation_content(created_at,hash) WHERE text!=''",
    'CREATE TABLE IF NOT EXISTS observation_frames (id TEXT PRIMARY KEY,character_id TEXT NOT NULL,at REAL NOT NULL,origin TEXT NOT NULL,source_key TEXT NOT NULL,revision TEXT NOT NULL,consent_epoch INTEGER NOT NULL,requires TEXT NOT NULL,metadata TEXT NOT NULL,content_hash TEXT NOT NULL,previous_id TEXT)',
    'CREATE INDEX IF NOT EXISTS observation_frame_time ON observation_frames(character_id,at)',
    'CREATE INDEX IF NOT EXISTS observation_frame_expiry ON observation_frames(at)',
    'CREATE INDEX IF NOT EXISTS observation_frame_content ON observation_frames(content_hash)',
    "CREATE INDEX IF NOT EXISTS observation_ready_queue ON observation_frames(COALESCE(json_extract(metadata,'$.transport_page'),0),character_id,at,id)",
    'CREATE INDEX IF NOT EXISTS observation_frame_latest_hash ON observation_frames(character_id,source_key,at,id,content_hash)',
    # The few frames of a source that still carry their accessibility tree.
    "CREATE INDEX IF NOT EXISTS observation_frame_nodes ON observation_frames(character_id,source_key,id) WHERE json_type(metadata,'$.nodes')='array'",
    'CREATE TABLE IF NOT EXISTS observation_analyses (id TEXT PRIMARY KEY,character_id TEXT NOT NULL,at REAL NOT NULL,run_id TEXT NOT NULL,body TEXT NOT NULL,dependencies TEXT NOT NULL)',
    'CREATE INDEX IF NOT EXISTS observation_analyses_character ON observation_analyses(character_id,at)',
    'CREATE INDEX IF NOT EXISTS observation_analyses_expiry ON observation_analyses(at)',
    'CREATE TABLE IF NOT EXISTS observation_processed (id TEXT PRIMARY KEY,analysis_id TEXT NOT NULL,interpreted_at REAL NOT NULL)',
    'CREATE TABLE IF NOT EXISTS observation_input_identity (fingerprint TEXT PRIMARY KEY,observation_id TEXT NOT NULL)',
    'CREATE INDEX IF NOT EXISTS observation_input_frame ON observation_input_identity(observation_id)',
    'CREATE TABLE IF NOT EXISTS observation_aliases (id TEXT PRIMARY KEY,canonical_id TEXT NOT NULL)',
    'CREATE INDEX IF NOT EXISTS observation_alias_target ON observation_aliases(canonical_id)',
    'CREATE TABLE IF NOT EXISTS observation_work_events (id TEXT PRIMARY KEY,character_id TEXT NOT NULL,at REAL NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,dependencies TEXT NOT NULL,analysis_id TEXT NOT NULL)',
    'CREATE INDEX IF NOT EXISTS observation_work_events_expiry ON observation_work_events(at)',
)

WORKLOG_SCHEMA = (
    'CREATE TABLE IF NOT EXISTS session_summaries (id TEXT PRIMARY KEY, character_id TEXT NOT NULL, kind TEXT NOT NULL, agent TEXT, session_key TEXT NOT NULL, project TEXT, cwd TEXT, day TEXT NOT NULL, start REAL NOT NULL, end REAL NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, task_id TEXT, yours INTEGER NOT NULL DEFAULT 0, agent_events INTEGER NOT NULL DEFAULT 0, away INTEGER NOT NULL DEFAULT 0, requires TEXT NOT NULL, sources TEXT NOT NULL, input_sha256 TEXT NOT NULL, run_id TEXT, model TEXT, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL, updated_at REAL NOT NULL)',
    'CREATE INDEX IF NOT EXISTS session_summaries_day ON session_summaries(character_id, day, start)',
    'CREATE INDEX IF NOT EXISTS session_summaries_task ON session_summaries(task_id)',
    'CREATE INDEX IF NOT EXISTS session_summaries_key ON session_summaries(session_key, start)',
    "CREATE TABLE IF NOT EXISTS task_cards (id TEXT PRIMARY KEY, character_id TEXT NOT NULL, project TEXT, title TEXT NOT NULL, goal TEXT NOT NULL, goal_authority TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active','done','parked','uncertain')), status_authority TEXT NOT NULL, progress TEXT NOT NULL, next_step TEXT, blockers TEXT NOT NULL DEFAULT '[]', first_at REAL NOT NULL, last_at REAL NOT NULL, revision INTEGER NOT NULL DEFAULT 1, edited INTEGER NOT NULL DEFAULT 0, requires TEXT NOT NULL, run_id TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL)",
    'CREATE INDEX IF NOT EXISTS task_cards_status ON task_cards(character_id, status, last_at)',
    "CREATE TABLE IF NOT EXISTS day_summaries (id TEXT PRIMARY KEY, character_id TEXT NOT NULL, period TEXT NOT NULL CHECK (period IN ('day','week')), date TEXT NOT NULL, timezone TEXT NOT NULL, headline TEXT NOT NULL, body TEXT NOT NULL, inject TEXT NOT NULL, partial INTEGER NOT NULL, sources TEXT NOT NULL, requires TEXT NOT NULL, state TEXT NOT NULL, run_id TEXT, model TEXT, generated_at REAL NOT NULL)",
    'CREATE UNIQUE INDEX IF NOT EXISTS day_summaries_unique ON day_summaries(character_id, period, date)',
)

SCHEDULE_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS schedules (schedule_id TEXT PRIMARY KEY, title TEXT NOT NULL, instruction TEXT NOT NULL,"
    " trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('daily','weekly','session_done')), trigger_json TEXT NOT NULL,"
    " enabled INTEGER NOT NULL DEFAULT 0, created_from TEXT NOT NULL CHECK (created_from IN ('user','agent_proposal')),"
    " conversation_id TEXT, next_run_at REAL, last_run_at REAL, last_job_id TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL, scope_id TEXT)",
    "CREATE INDEX IF NOT EXISTS schedules_due ON schedules(enabled,next_run_at)",
    "CREATE TABLE IF NOT EXISTS schedule_runs (run_id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, due_at REAL NOT NULL,"
    " started_at REAL, job_id TEXT, state TEXT NOT NULL CHECK (state IN ('started','skipped','missed','failed')), error TEXT)",
    "CREATE INDEX IF NOT EXISTS schedule_runs_schedule ON schedule_runs(schedule_id,due_at)",
)
