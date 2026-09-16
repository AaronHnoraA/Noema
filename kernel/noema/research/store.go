// Noema research notebook index is Copyright (c) 2026 Aaron He and
// distributed under the AGPL-3.0-or-later terms of the Noema kernel.

package research

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	_ "github.com/mattn/go-sqlite3"
)

// StateDirName is the repository-local runtime state directory.
const StateDirName = ".agent"

const schemaVersion = "21"

// coordinatorRequestsTable is shared by fresh databases and the v19 rebuild.
// D-032 queued Runs for the Pi coordinator; D-035 lets the Pi manager also ask
// Emacs to cancel a session's open Run or close its idle agent process.
const coordinatorRequestsTable = `CREATE TABLE IF NOT EXISTS coordinator_requests (
		id          TEXT PRIMARY KEY CHECK (id LIKE 'creq_%'),
		kind        TEXT NOT NULL CHECK (kind IN ('run.start', 'session.cancel', 'session.close')),
		payload_json TEXT NOT NULL,
		actor       TEXT NOT NULL,
		state       TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'done', 'failed')),
		claimed_by  TEXT NOT NULL DEFAULT '',
		created_at  INTEGER NOT NULL,
		claimed_at  INTEGER,
		lease_expires_at INTEGER,
		finished_at INTEGER,
		failure_reason TEXT NOT NULL DEFAULT '',
		version     INTEGER NOT NULL DEFAULT 1
	)`

var schemaStatements = []string{
	`CREATE TABLE IF NOT EXISTS schema_meta (
		key   TEXT PRIMARY KEY,
		value TEXT NOT NULL
	)`,
	// Schema v18 (D-031): project-scoped human names for logical sessions.
	// A name outlives any one physical Session; generation counts rebinds.
	`CREATE TABLE IF NOT EXISTS session_names (
		name        TEXT PRIMARY KEY,
		session_id  TEXT REFERENCES sessions(id),
		agent       TEXT NOT NULL,
		parent_name TEXT NOT NULL DEFAULT '',
		fork_mode   TEXT NOT NULL DEFAULT '',
		origin      TEXT NOT NULL CHECK (origin IN ('user', 'derived', 'pi', 'system')),
		state       TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived')),
		generation  INTEGER NOT NULL DEFAULT 0,
		created_at  INTEGER NOT NULL,
		updated_at  INTEGER NOT NULL,
		version     INTEGER NOT NULL DEFAULT 1
	)`,
	`CREATE INDEX IF NOT EXISTS idx_session_names_session ON session_names(session_id)`,
	`CREATE TABLE IF NOT EXISTS session_name_aliases (
		alias TEXT PRIMARY KEY,
		name  TEXT NOT NULL REFERENCES session_names(name) ON UPDATE CASCADE ON DELETE CASCADE
	)`,
	// D-032: durable requests from the Pi manager.  Emacs claims them and
	// carries them out through the ordinary worker, so Pi never drives a process.
	coordinatorRequestsTable,
	`CREATE INDEX IF NOT EXISTS idx_coordinator_requests_pending ON coordinator_requests(state, created_at)`,
	`CREATE TABLE IF NOT EXISTS run_stream_cache (
		run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
		seq         INTEGER NOT NULL,
		payload_json TEXT NOT NULL,
		byte_count  INTEGER NOT NULL CHECK (byte_count >= 0),
		created_at  INTEGER NOT NULL,
		expires_at  INTEGER NOT NULL,
		PRIMARY KEY (run_id, seq)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_run_stream_cache_expiry ON run_stream_cache(expires_at)`,
	`CREATE TABLE IF NOT EXISTS artifact_references (
		artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
		owner_kind  TEXT NOT NULL,
		owner_id    TEXT NOT NULL,
		created_at  INTEGER NOT NULL,
		PRIMARY KEY (artifact_id, owner_kind, owner_id)
	)`,
	`CREATE TABLE IF NOT EXISTS notebook_writebacks (
		run_id       TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
		notebook_path TEXT NOT NULL,
		cell_id      TEXT NOT NULL,
		output_json  TEXT NOT NULL,
		expected_revision TEXT NOT NULL DEFAULT '',
		state        TEXT NOT NULL CHECK (state IN ('pending', 'writing', 'done', 'conflict', 'failed')),
		attempts     INTEGER NOT NULL DEFAULT 0,
		next_attempt INTEGER NOT NULL,
		last_error   TEXT NOT NULL DEFAULT '',
		updated_at   INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_notebook_writebacks_due ON notebook_writebacks(state, next_attempt)`,
	`CREATE TABLE IF NOT EXISTS session_compactions (
		id              TEXT PRIMARY KEY CHECK (id LIKE 'compact_%'),
		session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
		generation      INTEGER NOT NULL,
		mode            TEXT NOT NULL CHECK (mode IN ('native', 'checkpoint')),
		status          TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
		old_native_session_id TEXT NOT NULL DEFAULT '',
		new_native_session_id TEXT NOT NULL DEFAULT '',
		checkpoint_artifact_id TEXT REFERENCES artifacts(id),
		failure_reason  TEXT NOT NULL DEFAULT '',
		created_at      INTEGER NOT NULL,
		finished_at     INTEGER
	)`,
	`CREATE TABLE IF NOT EXISTS session_usage (
		session_id    TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
		total_tokens  INTEGER NOT NULL DEFAULT 0,
		input_tokens  INTEGER NOT NULL DEFAULT 0,
		output_tokens INTEGER NOT NULL DEFAULT 0,
		thought_tokens INTEGER NOT NULL DEFAULT 0,
		cached_tokens INTEGER NOT NULL DEFAULT 0,
		context_used  INTEGER NOT NULL DEFAULT 0,
		context_size  INTEGER NOT NULL DEFAULT 0,
		updated_at    INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS run_session_names (
		run_id      TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
		name        TEXT NOT NULL,
		agent       TEXT NOT NULL,
		parent_name TEXT NOT NULL DEFAULT '',
		fork_mode   TEXT NOT NULL DEFAULT '',
		origin      TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS workstreams (
		id          TEXT PRIMARY KEY CHECK (id LIKE 'ws_%'),
		title       TEXT NOT NULL DEFAULT '',
		notebook_id TEXT,
		status      TEXT NOT NULL DEFAULT 'active',
		created_at  INTEGER NOT NULL,
		updated_at  INTEGER NOT NULL,
		version     INTEGER NOT NULL DEFAULT 1
	)`,
	`CREATE TABLE IF NOT EXISTS notebooks (
		id              TEXT PRIMARY KEY,
		path            TEXT NOT NULL UNIQUE,
		workstream_id   TEXT,
		title           TEXT NOT NULL DEFAULT '',
		revision_sha256 TEXT NOT NULL,
		indexed_at      INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS cells (
		notebook_id    TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
		cell_id        TEXT NOT NULL,
		cell_type      TEXT NOT NULL,
		kind           TEXT NOT NULL,
		title          TEXT NOT NULL DEFAULT '',
		state          TEXT NOT NULL DEFAULT '',
		outcome        TEXT NOT NULL DEFAULT '',
		dropped_reason TEXT NOT NULL DEFAULT '',
		result_of      TEXT NOT NULL DEFAULT '',
		ordinal        INTEGER NOT NULL,
		source_sha256  TEXT NOT NULL,
		outputs_sha256 TEXT NOT NULL DEFAULT '',
		latest_output  TEXT NOT NULL DEFAULT '',
		latest_run_id  TEXT NOT NULL DEFAULT '',
		output_status  TEXT NOT NULL DEFAULT '',
		output_agent   TEXT NOT NULL DEFAULT '',
		PRIMARY KEY (notebook_id, cell_id)
	)`,
	`CREATE TABLE IF NOT EXISTS edges (
		notebook_id       TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
		src_cell_id       TEXT NOT NULL,
		dst_cell_id       TEXT NOT NULL,
		type              TEXT NOT NULL CHECK (type IN ('lineage', 'depends')),
		notebook_revision TEXT NOT NULL,
		PRIMARY KEY (notebook_id, src_cell_id, dst_cell_id, type)
	)`,
	`CREATE TABLE IF NOT EXISTS work_nodes (
		notebook_id    TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
		work_node_id   TEXT NOT NULL,
		kind           TEXT NOT NULL CHECK (kind IN ('question', 'work', 'checkpoint')),
		title          TEXT NOT NULL DEFAULT '',
		state          TEXT NOT NULL DEFAULT '',
		outcome        TEXT NOT NULL DEFAULT '',
		dropped_reason TEXT NOT NULL DEFAULT '',
		disclosure     TEXT NOT NULL DEFAULT '',
		PRIMARY KEY (notebook_id, work_node_id)
	)`,
	`CREATE TABLE IF NOT EXISTS cell_work_nodes (
		notebook_id  TEXT NOT NULL,
		cell_id      TEXT NOT NULL,
		work_node_id TEXT NOT NULL,
		PRIMARY KEY (notebook_id, cell_id),
		FOREIGN KEY (notebook_id, cell_id) REFERENCES cells(notebook_id, cell_id) ON DELETE CASCADE,
		FOREIGN KEY (notebook_id, work_node_id) REFERENCES work_nodes(notebook_id, work_node_id) ON DELETE CASCADE
	)`,
	`CREATE INDEX IF NOT EXISTS idx_cell_work_nodes_node ON cell_work_nodes(notebook_id, work_node_id)`,
	`CREATE TABLE IF NOT EXISTS work_dependencies (
		notebook_id       TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
		dependency_id     TEXT NOT NULL,
		src_work_node_id  TEXT NOT NULL,
		dst_work_node_id  TEXT NOT NULL,
		type              TEXT NOT NULL CHECK (type IN ('lineage', 'depends')),
		notebook_revision TEXT NOT NULL,
		PRIMARY KEY (notebook_id, dependency_id),
		UNIQUE (notebook_id, src_work_node_id, dst_work_node_id, type),
		FOREIGN KEY (notebook_id, src_work_node_id) REFERENCES work_nodes(notebook_id, work_node_id) ON DELETE CASCADE,
		FOREIGN KEY (notebook_id, dst_work_node_id) REFERENCES work_nodes(notebook_id, work_node_id) ON DELETE CASCADE
	)`,
	`CREATE INDEX IF NOT EXISTS idx_work_dependencies_dst ON work_dependencies(notebook_id, dst_work_node_id)`,
	`CREATE TABLE IF NOT EXISTS sessions (
		id                    TEXT PRIMARY KEY CHECK (id LIKE 'ses_%'),
		workstream_id         TEXT NOT NULL REFERENCES workstreams(id),
		adapter                TEXT NOT NULL,
		transport              TEXT NOT NULL CHECK (transport IN ('acp', 'cli', 'pty')),
		native_session_id      TEXT NOT NULL,
		execution_target       TEXT NOT NULL,
		parent_session_id      TEXT REFERENCES sessions(id),
		fork_mode              TEXT NOT NULL DEFAULT '',
		state                  TEXT NOT NULL CHECK (state IN ('active', 'warm', 'archived', 'lost')),
		capabilities_json      TEXT NOT NULL DEFAULT '{}',
		attached_at            INTEGER NOT NULL,
		started_at             INTEGER,
		last_seen_at           INTEGER,
		version                INTEGER NOT NULL DEFAULT 1
	)`,
	`CREATE TABLE IF NOT EXISTS artifacts (
		id          TEXT PRIMARY KEY CHECK (id LIKE 'art_%'),
		kind        TEXT NOT NULL,
		sha256      TEXT NOT NULL,
		media_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
		byte_count  INTEGER NOT NULL CHECK (byte_count >= 0),
		created_at  INTEGER NOT NULL,
		UNIQUE(kind, sha256)
	)`,
	`CREATE TABLE IF NOT EXISTS artifact_sources (
		id             TEXT PRIMARY KEY CHECK (id LIKE 'asrc_%'),
		workstream_id  TEXT NOT NULL REFERENCES workstreams(id),
		path           TEXT NOT NULL,
		source_uri     TEXT NOT NULL,
		artifact_id    TEXT NOT NULL REFERENCES artifacts(id),
		content_sha256 TEXT NOT NULL,
		parser_version TEXT NOT NULL,
		byte_count     INTEGER NOT NULL CHECK (byte_count >= 0),
		modified_ns    INTEGER NOT NULL DEFAULT 0,
		indexed_at     INTEGER NOT NULL,
		UNIQUE(workstream_id, path),
		UNIQUE(workstream_id, source_uri)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_artifact_sources_workstream
		ON artifact_sources(workstream_id, path)`,
	`CREATE INDEX IF NOT EXISTS idx_artifact_sources_artifact
		ON artifact_sources(artifact_id, workstream_id)`,
	`CREATE TABLE IF NOT EXISTS artifact_blocks (
		id             TEXT PRIMARY KEY CHECK (id LIKE 'ablk_%'),
		source_id      TEXT NOT NULL REFERENCES artifact_sources(id) ON DELETE CASCADE,
		artifact_id    TEXT NOT NULL REFERENCES artifacts(id),
		ordinal        INTEGER NOT NULL CHECK (ordinal >= 0),
		kind           TEXT NOT NULL CHECK (kind IN ('heading', 'paragraph', 'list', 'quote', 'code')),
		byte_start     INTEGER NOT NULL CHECK (byte_start >= 0),
		byte_end       INTEGER NOT NULL CHECK (byte_end > byte_start),
		content        TEXT NOT NULL,
		content_sha256 TEXT NOT NULL,
		ast_path       TEXT NOT NULL,
		indexed_at     INTEGER NOT NULL,
		UNIQUE(source_id, ordinal),
		UNIQUE(source_id, byte_start, byte_end)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_artifact_blocks_artifact_span
		ON artifact_blocks(artifact_id, byte_start, byte_end)`,
	`CREATE INDEX IF NOT EXISTS idx_artifact_blocks_source
		ON artifact_blocks(source_id, ordinal)`,
	`CREATE TABLE IF NOT EXISTS artifact_corpus_generations (
		workstream_id TEXT PRIMARY KEY REFERENCES workstreams(id),
		generation    INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
		updated_at    INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS captures (
		id                TEXT PRIMARY KEY CHECK (id LIKE 'cap_%'),
		client_request_id TEXT NOT NULL UNIQUE,
		artifact_id       TEXT NOT NULL REFERENCES artifacts(id),
		html_artifact_id  TEXT REFERENCES artifacts(id),
		workstream_id     TEXT REFERENCES workstreams(id),
		url               TEXT NOT NULL,
		title             TEXT NOT NULL DEFAULT '',
		adapter           TEXT NOT NULL,
		completeness      TEXT NOT NULL CHECK (completeness IN ('selection', 'full', 'partial', 'export')),
		captured_at       INTEGER NOT NULL,
		created_at        INTEGER NOT NULL,
		metadata_json     TEXT NOT NULL DEFAULT '{}'
	)`,
	`CREATE INDEX IF NOT EXISTS idx_captures_created ON captures(created_at DESC)`,
	`CREATE TABLE IF NOT EXISTS runs (
		id                  TEXT PRIMARY KEY CHECK (id LIKE 'run_%'),
		workstream_id       TEXT NOT NULL REFERENCES workstreams(id),
		session_id          TEXT REFERENCES sessions(id),
		notebook_id         TEXT,
		cell_id             TEXT,
		work_node_id        TEXT,
		source_kind         TEXT NOT NULL CHECK (source_kind IN ('work-cell', 'project-file', 'prompt-file', 'promoted-session')),
		execution_target    TEXT NOT NULL,
		status              TEXT NOT NULL CHECK (status IN ('preparing', 'running', 'waiting_permission', 'waiting_input', 'completed', 'cancelled', 'failed', 'interrupted')),
		spec_artifact_id    TEXT NOT NULL REFERENCES artifacts(id),
		context_artifact_id TEXT REFERENCES artifacts(id),
		created_at          INTEGER NOT NULL,
		started_at          INTEGER,
		finished_at         INTEGER,
		failure_reason      TEXT NOT NULL DEFAULT '',
		version             INTEGER NOT NULL DEFAULT 1
	)`,
	`CREATE INDEX IF NOT EXISTS idx_runs_session_active ON runs(session_id, status, created_at DESC)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS one_open_run_per_session ON runs(session_id)
		WHERE session_id IS NOT NULL AND status IN ('preparing', 'running', 'waiting_permission', 'waiting_input')`,
	`CREATE INDEX IF NOT EXISTS idx_runs_workstream_created ON runs(workstream_id, created_at DESC)`,
	`CREATE TABLE IF NOT EXISTS artifact_links (
		artifact_id   TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
		run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
		workstream_id TEXT NOT NULL REFERENCES workstreams(id),
		notebook_id   TEXT NOT NULL DEFAULT '',
		work_node_id  TEXT NOT NULL DEFAULT '',
		cell_id       TEXT NOT NULL DEFAULT '',
		source_uri    TEXT NOT NULL DEFAULT '',
		relation      TEXT NOT NULL CHECK (relation IN ('created', 'modified', 'produced')),
		created_at    INTEGER NOT NULL,
		PRIMARY KEY (artifact_id, run_id, source_uri, relation)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_artifact_links_work_node
		ON artifact_links(workstream_id, notebook_id, work_node_id, created_at DESC)`,
	`CREATE INDEX IF NOT EXISTS idx_artifact_links_run ON artifact_links(run_id, created_at DESC)`,
	`CREATE TABLE IF NOT EXISTS leases (
		session_id  TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
		owner       TEXT NOT NULL,
		epoch       INTEGER NOT NULL CHECK (epoch > 0),
		acquired_at INTEGER NOT NULL,
		expires_at  INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_leases_expires ON leases(expires_at)`,
	`CREATE TABLE IF NOT EXISTS permissions (
		id                TEXT PRIMARY KEY CHECK (id LIKE 'perm_%'),
		run_id            TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
		session_id        TEXT NOT NULL REFERENCES sessions(id),
		native_request_id TEXT NOT NULL,
		action_sha256     TEXT NOT NULL,
		action_json       TEXT NOT NULL,
		options_json      TEXT NOT NULL,
		state             TEXT NOT NULL CHECK (state IN ('pending', 'resolved', 'expired')),
		option_id         TEXT NOT NULL DEFAULT '',
		decided_by        TEXT NOT NULL DEFAULT '',
		created_at        INTEGER NOT NULL,
		resolved_at       INTEGER,
		lease_epoch      INTEGER NOT NULL DEFAULT 0,
		version           INTEGER NOT NULL DEFAULT 1,
		UNIQUE(session_id, native_request_id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_permissions_run_state ON permissions(run_id, state, created_at)`,
	`CREATE TABLE IF NOT EXISTS input_requests (
		id                TEXT PRIMARY KEY CHECK (id LIKE 'input_%'),
		run_id            TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
		session_id        TEXT NOT NULL REFERENCES sessions(id),
		native_request_id TEXT NOT NULL,
		prompt            TEXT NOT NULL,
		input_kind        TEXT NOT NULL DEFAULT 'text',
		options_json      TEXT NOT NULL DEFAULT '[]',
		state             TEXT NOT NULL CHECK (state IN ('pending', 'resolved', 'expired')),
		answer_json       TEXT,
		answered_by       TEXT NOT NULL DEFAULT '',
		created_at        INTEGER NOT NULL,
		resolved_at       INTEGER,
		lease_epoch       INTEGER NOT NULL CHECK (lease_epoch > 0),
		version           INTEGER NOT NULL DEFAULT 1,
		UNIQUE(session_id, native_request_id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_input_requests_run_state ON input_requests(run_id, state, created_at)`,
	`CREATE TABLE IF NOT EXISTS permission_rules (
		id            TEXT PRIMARY KEY CHECK (id LIKE 'prule_%'),
		scope         TEXT NOT NULL CHECK (scope IN ('session', 'workstream', 'project')),
		scope_id      TEXT NOT NULL,
		effect        TEXT NOT NULL CHECK (effect IN ('allow', 'reject')),
		matcher_json  TEXT NOT NULL,
		created_at    INTEGER NOT NULL,
		created_by    TEXT NOT NULL DEFAULT '',
		enabled       INTEGER NOT NULL DEFAULT 1
	)`,
	`CREATE INDEX IF NOT EXISTS idx_permission_rules_scope ON permission_rules(scope, scope_id, enabled)`,
	`CREATE TABLE IF NOT EXISTS events (
		seq           INTEGER PRIMARY KEY AUTOINCREMENT,
		id            TEXT NOT NULL UNIQUE CHECK (id LIKE 'evt_%'),
		type          TEXT NOT NULL,
		ts            INTEGER NOT NULL,
		workstream_id TEXT,
		notebook_id   TEXT,
		cell_id       TEXT,
		work_node_id  TEXT,
		run_id        TEXT,
		session_id    TEXT,
		causation_id  TEXT,
		payload_json  TEXT NOT NULL DEFAULT '{}'
	)`,
	`CREATE INDEX IF NOT EXISTS idx_events_notebook_seq ON events(notebook_id, seq)`,
	// Terminal-artifact lookups and segment retention read one Run's events by type.
	`CREATE INDEX IF NOT EXISTS idx_events_run_type ON events(run_id, type)`,
	`CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(notebook_id, dst_cell_id)`,
	`CREATE INDEX IF NOT EXISTS idx_sessions_workstream ON sessions(workstream_id, attached_at DESC)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS sessions_native_binding
		ON sessions(adapter, native_session_id, execution_target)`,
	`CREATE TABLE IF NOT EXISTS manual_interventions (
		id               TEXT PRIMARY KEY CHECK (id LIKE 'manual_%'),
		session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
		transport        TEXT NOT NULL CHECK (transport = 'pty'),
		command_json     TEXT NOT NULL,
		state            TEXT NOT NULL CHECK (state IN ('active', 'ended')),
		started_by       TEXT NOT NULL,
		started_at       INTEGER NOT NULL,
		ended_by         TEXT NOT NULL DEFAULT '',
		ended_at         INTEGER,
		reason           TEXT NOT NULL DEFAULT '',
		version          INTEGER NOT NULL DEFAULT 1
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS one_active_manual_intervention_per_session
		ON manual_interventions(session_id) WHERE state = 'active'`,
	`CREATE TABLE IF NOT EXISTS proposals (
		id                    TEXT PRIMARY KEY CHECK (id LIKE 'prop_%'),
		client_request_id     TEXT NOT NULL UNIQUE,
		workstream_id         TEXT NOT NULL REFERENCES workstreams(id),
		kind                  TEXT NOT NULL CHECK (kind IN ('cell.create', 'finding.create', 'research_ir.create', 'problem_model.create', 'task.create', 'job.create', 'delegation.create')),
		payload_json          TEXT NOT NULL,
		payload_sha256        TEXT NOT NULL,
		status                TEXT NOT NULL CHECK (status IN ('pending', 'accepting', 'accepted', 'rejected')),
		proposed_by           TEXT NOT NULL,
		source_adapter        TEXT NOT NULL,
		created_at            INTEGER NOT NULL,
		reviewed_by           TEXT NOT NULL DEFAULT '',
		reviewed_at           INTEGER,
		rejection_reason      TEXT NOT NULL DEFAULT '',
		accepted_ref          TEXT NOT NULL DEFAULT '',
		reviewed_payload_json TEXT,
		version               INTEGER NOT NULL DEFAULT 1
	)`,
	`CREATE INDEX IF NOT EXISTS idx_proposals_attention
		ON proposals(status, created_at, id)`,
	`CREATE INDEX IF NOT EXISTS idx_proposals_workstream
		ON proposals(workstream_id, created_at DESC, id DESC)`,
	`CREATE TABLE IF NOT EXISTS findings (
		id                 TEXT PRIMARY KEY CHECK (id LIKE 'finding_%'),
		workstream_id      TEXT NOT NULL REFERENCES workstreams(id),
		kind               TEXT NOT NULL,
		statement          TEXT NOT NULL,
		status             TEXT NOT NULL CHECK (status IN ('proposed', 'supported', 'disputed', 'refuted', 'accepted', 'superseded')),
		verification_level TEXT NOT NULL CHECK (verification_level IN ('unreviewed', 'agent_checked', 'reproduced', 'human_reviewed', 'formally_verified')),
		verification_json  TEXT NOT NULL DEFAULT '{}',
		scope_json         TEXT NOT NULL DEFAULT '{}',
		origin_json        TEXT NOT NULL DEFAULT '{}',
		disclosure         TEXT NOT NULL CHECK (disclosure IN ('project', 'local_only')),
		semantic_sha256    TEXT NOT NULL,
		created_at         INTEGER NOT NULL,
		version            INTEGER NOT NULL DEFAULT 1,
		UNIQUE(workstream_id, semantic_sha256)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_findings_workstream
		ON findings(workstream_id, created_at DESC, id DESC)`,
	`CREATE INDEX IF NOT EXISTS idx_findings_status
		ON findings(workstream_id, status, verification_level)`,
	`CREATE TABLE IF NOT EXISTS finding_evidence (
		id           TEXT PRIMARY KEY CHECK (id LIKE 'evidence_%'),
		finding_id   TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
		artifact_id  TEXT NOT NULL REFERENCES artifacts(id),
		relation     TEXT NOT NULL CHECK (relation IN ('supports', 'refutes', 'qualifies', 'context', 'insufficient')),
		byte_start   INTEGER NOT NULL CHECK (byte_start >= 0),
		byte_end     INTEGER NOT NULL CHECK (byte_end > byte_start),
		block_sha256 TEXT NOT NULL,
		ast_path     TEXT NOT NULL DEFAULT '',
		created_at   INTEGER NOT NULL,
		UNIQUE(finding_id, artifact_id, relation, byte_start, byte_end)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_finding_evidence_artifact
		ON finding_evidence(artifact_id, byte_start, byte_end)`,
	`CREATE TABLE IF NOT EXISTS finding_relations (
		source_finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
		target_finding_id TEXT NOT NULL REFERENCES findings(id),
		type              TEXT NOT NULL,
		relation_class    TEXT NOT NULL CHECK (relation_class IN ('semantic', 'provenance')),
		created_at        INTEGER NOT NULL,
		PRIMARY KEY(source_finding_id, target_finding_id, type, relation_class),
		CHECK(source_finding_id <> target_finding_id)
	)`,
	`CREATE TABLE IF NOT EXISTS research_ir_versions (
		workstream_id TEXT NOT NULL REFERENCES workstreams(id),
		version       INTEGER NOT NULL CHECK (version > 0),
		document_json TEXT NOT NULL,
		sha256        TEXT NOT NULL,
		created_by    TEXT NOT NULL,
		created_at    INTEGER NOT NULL,
		review_status TEXT NOT NULL DEFAULT 'human_reviewed',
		PRIMARY KEY(workstream_id, version),
		UNIQUE(workstream_id, sha256)
	)`,
	`CREATE TABLE IF NOT EXISTS problem_model_versions (
		id                  TEXT NOT NULL CHECK (id LIKE 'pm_%'),
		workstream_id       TEXT NOT NULL REFERENCES workstreams(id),
		version             INTEGER NOT NULL CHECK (version > 0),
		document_json       TEXT NOT NULL,
		sha256              TEXT NOT NULL,
		research_ir_version INTEGER NOT NULL CHECK (research_ir_version > 0),
		artifact_set_hash   TEXT NOT NULL,
		policy_hash         TEXT NOT NULL,
		created_by          TEXT NOT NULL,
		created_at          INTEGER NOT NULL,
		review_status       TEXT NOT NULL DEFAULT 'human_reviewed',
		PRIMARY KEY(workstream_id, version),
		UNIQUE(workstream_id, sha256),
		FOREIGN KEY(workstream_id, research_ir_version) REFERENCES research_ir_versions(workstream_id, version)
	)`,
	`CREATE TABLE IF NOT EXISTS tasks (
		id                       TEXT PRIMARY KEY CHECK (id LIKE 'task_%'),
		client_request_id        TEXT NOT NULL UNIQUE,
		request_sha256           TEXT NOT NULL DEFAULT '',
		workstream_id            TEXT NOT NULL REFERENCES workstreams(id),
		parent_task_id           TEXT REFERENCES tasks(id),
		title                    TEXT NOT NULL,
		objective                TEXT NOT NULL,
		acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
		state                    TEXT NOT NULL CHECK (state IN ('open', 'blocked', 'completed', 'cancelled')),
		priority                 INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
		disclosure               TEXT NOT NULL CHECK (disclosure IN ('project', 'local_only')),
		created_by               TEXT NOT NULL,
		origin_proposal_id       TEXT NOT NULL DEFAULT '',
		created_at               INTEGER NOT NULL,
		updated_at               INTEGER NOT NULL,
		version                  INTEGER NOT NULL DEFAULT 1
	)`,
	`CREATE INDEX IF NOT EXISTS idx_tasks_workstream_state
		ON tasks(workstream_id, state, priority DESC, created_at, id)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_origin_proposal
		ON tasks(origin_proposal_id) WHERE origin_proposal_id <> ''`,
	`CREATE TABLE IF NOT EXISTS task_edges (
		parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
		child_task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
		type           TEXT NOT NULL CHECK (type IN ('decomposes', 'depends')),
		created_at     INTEGER NOT NULL,
		PRIMARY KEY(parent_task_id, child_task_id, type),
		CHECK(parent_task_id <> child_task_id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_task_edges_child ON task_edges(child_task_id, type)`,
	`CREATE TABLE IF NOT EXISTS workers (
		id                    TEXT PRIMARY KEY,
		kind                  TEXT NOT NULL CHECK (kind IN ('deterministic', 'pi', 'pi-orchestrator', 'acp', 'jupyter', 'remote', 'compatibility')),
		profile               TEXT NOT NULL DEFAULT '',
		transport             TEXT NOT NULL,
		capabilities_json     TEXT NOT NULL DEFAULT '[]',
		inference_capable     INTEGER NOT NULL DEFAULT 0 CHECK (inference_capable IN (0, 1)),
		state                 TEXT NOT NULL CHECK (state IN ('available', 'draining', 'offline')),
		registered_at         INTEGER NOT NULL,
		last_seen_at          INTEGER NOT NULL,
		version               INTEGER NOT NULL DEFAULT 1
	)`,
	`CREATE INDEX IF NOT EXISTS idx_workers_state_kind ON workers(state, kind, last_seen_at DESC)`,
	`CREATE TABLE IF NOT EXISTS jobs (
		id                        TEXT PRIMARY KEY CHECK (id LIKE 'job_%'),
		client_request_id         TEXT NOT NULL UNIQUE,
		request_sha256            TEXT NOT NULL DEFAULT '',
		workstream_id             TEXT NOT NULL REFERENCES workstreams(id),
		task_id                   TEXT NOT NULL REFERENCES tasks(id),
		kind                      TEXT NOT NULL,
		state                     TEXT NOT NULL CHECK (state IN ('queued', 'claimed', 'running', 'input_required', 'permission_required', 'completed', 'failed', 'orphaned', 'cancelled')),
		inputs_json               TEXT NOT NULL DEFAULT '{}',
		requirements_json         TEXT NOT NULL DEFAULT '{}',
		inference_policy          TEXT NOT NULL CHECK (inference_policy IN ('forbidden', 'optional', 'required')),
		local_preferred           INTEGER NOT NULL DEFAULT 0 CHECK (local_preferred IN (0, 1)),
		minimum_capability        TEXT NOT NULL DEFAULT '',
		effect_class              TEXT NOT NULL CHECK (effect_class IN ('pure', 'idempotent', 'derived-state-write', 'workspace-mutating', 'external-mutating', 'unknown')),
		budget_json               TEXT NOT NULL DEFAULT '{}',
		retry_policy              TEXT NOT NULL CHECK (retry_policy IN ('none', 'safe_only', 'manual')),
		attempts_max              INTEGER NOT NULL CHECK (attempts_max BETWEEN 1 AND 100),
		attempts_started          INTEGER NOT NULL DEFAULT 0 CHECK (attempts_started >= 0),
		deterministic_state       TEXT NOT NULL CHECK (deterministic_state IN ('pending', 'unresolved', 'resolved', 'not_applicable')),
		completion_condition_json TEXT NOT NULL DEFAULT '{}',
		origin_proposal_id        TEXT NOT NULL DEFAULT '',
		created_by                TEXT NOT NULL,
		created_at                INTEGER NOT NULL,
		updated_at                INTEGER NOT NULL,
		finished_at               INTEGER,
		failure_reason            TEXT NOT NULL DEFAULT '',
		lease_epoch               INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
		version                   INTEGER NOT NULL DEFAULT 1
	)`,
	`CREATE INDEX IF NOT EXISTS idx_jobs_queue
		ON jobs(state, workstream_id, created_at, id)`,
	`CREATE INDEX IF NOT EXISTS idx_jobs_task ON jobs(task_id, created_at, id)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_origin_proposal
		ON jobs(origin_proposal_id) WHERE origin_proposal_id <> ''`,
	`CREATE TABLE IF NOT EXISTS job_dependencies (
		job_id            TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
		dependency_job_id TEXT NOT NULL REFERENCES jobs(id),
		created_at        INTEGER NOT NULL,
		PRIMARY KEY(job_id, dependency_job_id),
		CHECK(job_id <> dependency_job_id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_job_dependencies_parent
		ON job_dependencies(dependency_job_id, job_id)`,
	`CREATE TABLE IF NOT EXISTS invocations (
		id                   TEXT PRIMARY KEY CHECK (id LIKE 'inv_%'),
		claim_request_id     TEXT NOT NULL UNIQUE,
		claim_request_sha256 TEXT NOT NULL DEFAULT '',
		job_id               TEXT NOT NULL REFERENCES jobs(id),
		attempt              INTEGER NOT NULL CHECK (attempt > 0),
		worker_id            TEXT NOT NULL REFERENCES workers(id),
		worker_snapshot_json TEXT NOT NULL,
		execution_mode       TEXT NOT NULL CHECK (execution_mode IN ('deterministic', 'inference')),
		runtime_json         TEXT NOT NULL DEFAULT '{}',
		resolved_resources_json TEXT NOT NULL DEFAULT '[]',
		context_snapshot     TEXT NOT NULL DEFAULT '',
		disclosure_view      TEXT NOT NULL DEFAULT '',
		problem_model_version INTEGER NOT NULL DEFAULT 0 CHECK (problem_model_version >= 0),
		budget_json          TEXT NOT NULL DEFAULT '{}',
		policy_hash          TEXT NOT NULL,
		idempotency_key      TEXT NOT NULL UNIQUE,
		spec_json            TEXT NOT NULL,
		spec_sha256          TEXT NOT NULL,
		created_at           INTEGER NOT NULL,
		UNIQUE(job_id, attempt)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_invocations_job ON invocations(job_id, attempt DESC)`,
	`CREATE TABLE IF NOT EXISTS invocation_results (
		invocation_id       TEXT PRIMARY KEY REFERENCES invocations(id),
		status              TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'unresolved', 'orphaned', 'cancelled')),
		result_json         TEXT NOT NULL DEFAULT '{}',
		failure_reason      TEXT NOT NULL DEFAULT '',
		input_tokens        INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
		output_tokens       INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
		cost_microusd       INTEGER NOT NULL DEFAULT 0 CHECK (cost_microusd >= 0),
		inference_calls     INTEGER NOT NULL DEFAULT 0 CHECK (inference_calls >= 0),
		observed_wall_ms    INTEGER NOT NULL DEFAULT 0 CHECK (observed_wall_ms >= 0),
		finished_at         INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS worker_leases (
		job_id             TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
		invocation_id      TEXT NOT NULL UNIQUE REFERENCES invocations(id) ON DELETE CASCADE,
		worker_id          TEXT NOT NULL REFERENCES workers(id),
		lease_token        TEXT NOT NULL,
		epoch              INTEGER NOT NULL CHECK (epoch > 0),
		acquired_at        INTEGER NOT NULL,
		expires_at         INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_worker_leases_expiry ON worker_leases(expires_at)`,
	`CREATE TABLE IF NOT EXISTS job_artifacts (
		job_id        TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
		invocation_id TEXT NOT NULL REFERENCES invocations(id),
		artifact_id   TEXT NOT NULL REFERENCES artifacts(id),
		role          TEXT NOT NULL CHECK (role IN ('input', 'output', 'log', 'checkpoint')),
		created_at    INTEGER NOT NULL,
		PRIMARY KEY(job_id, invocation_id, artifact_id, role)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_job_artifacts_artifact ON job_artifacts(artifact_id, role)`,
	`CREATE TABLE IF NOT EXISTS delegations (
		id                   TEXT PRIMARY KEY CHECK (id LIKE 'del_%'),
		client_request_id    TEXT NOT NULL UNIQUE,
		request_sha256       TEXT NOT NULL DEFAULT '',
		workstream_id        TEXT NOT NULL REFERENCES workstreams(id),
		parent_task_id       TEXT NOT NULL REFERENCES tasks(id),
		parent_invocation_id TEXT REFERENCES invocations(id),
		requested_by_type    TEXT NOT NULL CHECK (requested_by_type IN ('human', 'agent', 'worker', 'system')),
		requested_by_id      TEXT NOT NULL,
		reason_json          TEXT NOT NULL,
		child_task_id        TEXT NOT NULL REFERENCES tasks(id),
		target_json          TEXT NOT NULL DEFAULT '{}',
		constraints_json     TEXT NOT NULL DEFAULT '{}',
		origin_proposal_id   TEXT NOT NULL DEFAULT '',
		created_at           INTEGER NOT NULL,
		version              INTEGER NOT NULL DEFAULT 1,
		CHECK(parent_task_id <> child_task_id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_delegations_parent ON delegations(parent_task_id, created_at, id)`,
	`CREATE INDEX IF NOT EXISTS idx_delegations_child ON delegations(child_task_id, created_at, id)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_delegations_origin_proposal
		ON delegations(origin_proposal_id) WHERE origin_proposal_id <> ''`,
	`CREATE TABLE IF NOT EXISTS delegation_jobs (
		delegation_id TEXT NOT NULL REFERENCES delegations(id) ON DELETE CASCADE,
		job_id        TEXT NOT NULL REFERENCES jobs(id),
		PRIMARY KEY(delegation_id, job_id)
	)`,
}

// Store is one repository's research state database.
type Store struct {
	root      string
	db        *sql.DB
	mu        sync.Mutex
	historyMu sync.Mutex
	historyDB *sql.DB
}

var (
	storesMu sync.Mutex
	stores   = map[string]*Store{}
)

// Open returns the research store for an absolute repository root, creating
// `<root>/.agent/state.sqlite` when needed.
func Open(root string) (*Store, error) {
	clean, err := cleanRoot(root)
	if err != nil {
		return nil, err
	}
	storesMu.Lock()
	defer storesMu.Unlock()
	if store := stores[clean]; store != nil {
		return store, nil
	}
	dir := filepath.Join(clean, StateDirName)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create research state directory: %w", err)
	}
	if err := ensureStateIgnored(dir); err != nil {
		return nil, fmt.Errorf("protect research state directory: %w", err)
	}
	dsn := filepath.Join(dir, "state.sqlite") +
		"?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=on&_synchronous=FULL&_txlock=immediate"
	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, fmt.Errorf("open research state: %w", err)
	}
	// Schema rebuilds use connection-local SQLite pragmas.  No caller can see
	// this database yet, so keep migration on one connection and widen the pool
	// only after it succeeds.
	db.SetMaxOpenConns(1)
	if err := migrate(db); err != nil {
		_ = db.Close()
		return nil, err
	}
	db.SetMaxOpenConns(4)
	store := &Store{root: clean, db: db}
	stores[clean] = store
	return store, nil
}

// CloseAll closes every open research store.
func CloseAll() {
	storesMu.Lock()
	defer storesMu.Unlock()
	for root, store := range stores {
		_ = store.db.Close()
		if store.historyDB != nil {
			_ = store.historyDB.Close()
		}
		delete(stores, root)
	}
}

// ensureStateIgnored makes the state directory ignore itself, so repositories
// whose `.gitignore` predates `.agent/` never commit runtime state.
func ensureStateIgnored(dir string) error {
	path := filepath.Join(dir, ".gitignore")
	if _, err := os.Stat(path); err == nil || !os.IsNotExist(err) {
		return err
	}
	return os.WriteFile(path, []byte("*\n"), 0o644)
}

func cleanRoot(root string) (string, error) {
	root = strings.TrimSpace(root)
	if root == "" || !filepath.IsAbs(root) {
		return "", errors.New("research repository root must be an absolute path")
	}
	clean := filepath.Clean(root)
	info, err := os.Stat(clean)
	if err != nil {
		return "", fmt.Errorf("research repository root: %w", err)
	}
	if !info.IsDir() {
		return "", errors.New("research repository root is not a directory")
	}
	return clean, nil
}

func migrate(db *sql.DB) error {
	for _, statement := range schemaStatements {
		if _, err := db.Exec(statement); err != nil {
			return fmt.Errorf("migrate research state: %w", err)
		}
	}
	// Schema v5 started binding permission decisions to the worker epoch that
	// requested them. Existing unresolved rows intentionally receive epoch 0,
	// which makes them unapprovable rather than allowing delivery to a newer
	// worker. Fresh databases get the same column from the CREATE statement.
	if err := ensureColumn(db, "permissions", "lease_epoch", `ALTER TABLE permissions ADD COLUMN lease_epoch INTEGER NOT NULL DEFAULT 0`); err != nil {
		return err
	}
	// Schema v8 added an explicit acceptance reservation for cell Proposals.
	// Schema v9 also makes Job and Delegation candidates reviewable. SQLite
	// CHECK constraints require rebuilding the table while preserving history.
	if err := migrateProposalSchema(db); err != nil {
		return err
	}
	// Schema v10 binds every orchestration idempotency key to a canonical
	// request digest. Reusing a key for different work must fail closed.
	for _, column := range []struct {
		table, name, statement string
	}{
		{"tasks", "request_sha256", `ALTER TABLE tasks ADD COLUMN request_sha256 TEXT NOT NULL DEFAULT ''`},
		{"jobs", "request_sha256", `ALTER TABLE jobs ADD COLUMN request_sha256 TEXT NOT NULL DEFAULT ''`},
		{"invocations", "claim_request_sha256", `ALTER TABLE invocations ADD COLUMN claim_request_sha256 TEXT NOT NULL DEFAULT ''`},
		{"delegations", "request_sha256", `ALTER TABLE delegations ADD COLUMN request_sha256 TEXT NOT NULL DEFAULT ''`},
		{"runs", "work_node_id", `ALTER TABLE runs ADD COLUMN work_node_id TEXT`},
		{"events", "work_node_id", `ALTER TABLE events ADD COLUMN work_node_id TEXT`},
		{"cells", "outputs_sha256", `ALTER TABLE cells ADD COLUMN outputs_sha256 TEXT NOT NULL DEFAULT ''`},
		{"cells", "latest_output", `ALTER TABLE cells ADD COLUMN latest_output TEXT NOT NULL DEFAULT ''`},
		{"cells", "latest_run_id", `ALTER TABLE cells ADD COLUMN latest_run_id TEXT NOT NULL DEFAULT ''`},
		{"cells", "output_status", `ALTER TABLE cells ADD COLUMN output_status TEXT NOT NULL DEFAULT ''`},
		{"work_nodes", "agenda_json", `ALTER TABLE work_nodes ADD COLUMN agenda_json TEXT NOT NULL DEFAULT ''`},
		{"cells", "output_agent", `ALTER TABLE cells ADD COLUMN output_agent TEXT NOT NULL DEFAULT ''`},
	} {
		if err := ensureColumn(db, column.table, column.name, column.statement); err != nil {
			return err
		}
	}
	// Schema v17 added non-agent project-file Runs.  SQLite cannot alter a
	// CHECK constraint in place, so rebuild the table after all legacy columns
	// are present.  legacy_alter_table keeps dependent foreign keys pointed at
	// the final `runs' name while the old table is renamed.
	if err := migrateRunSourceSchema(db); err != nil {
		return err
	}
	// Schema v19 added cancel/close; v20 adds claim leases and terminal acks.
	if err := migrateCoordinatorRequestKinds(db); err != nil {
		return err
	}
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_coordinator_requests_lease
		ON coordinator_requests(state, lease_expires_at)`); err != nil {
		return fmt.Errorf("migrate coordinator request lease index: %w", err)
	}
	_, err := db.Exec(`INSERT INTO schema_meta(key, value) VALUES('schema_version', ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, schemaVersion)
	return err
}

// migrateCoordinatorRequestKinds rebuilds pre-v20 coordinator requests.
// Nothing references the table, so a rename-copy-drop keeps every request.
func migrateCoordinatorRequestKinds(db *sql.DB) error {
	var tableSQL string
	err := db.QueryRow(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'coordinator_requests'`).Scan(&tableSQL)
	// Looking for the terminal state names is insufficient: a test or an
	// intermediate schema can already allow `done' while retaining the old
	// request-kind CHECK.  The lease column is the unambiguous v20 marker.
	if errors.Is(err, sql.ErrNoRows) ||
		(strings.Contains(tableSQL, "kind IN ('run.start', 'session.cancel', 'session.close')") &&
			strings.Contains(tableSQL, "lease_expires_at")) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect coordinator request kinds: %w", err)
	}
	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin coordinator request migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	for _, statement := range []string{
		`DROP INDEX IF EXISTS idx_coordinator_requests_pending`,
		`ALTER TABLE coordinator_requests RENAME TO coordinator_requests_before_v19`,
		coordinatorRequestsTable,
		`INSERT INTO coordinator_requests(id, kind, payload_json, actor, state, claimed_by, created_at, claimed_at, version)
		 SELECT id, kind, payload_json, actor, state, claimed_by, created_at, claimed_at, version FROM coordinator_requests_before_v19`,
		`DROP TABLE coordinator_requests_before_v19`,
		`CREATE INDEX IF NOT EXISTS idx_coordinator_requests_pending ON coordinator_requests(state, created_at)`,
	} {
		if _, err := tx.Exec(statement); err != nil {
			return fmt.Errorf("migrate coordinator request kinds: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit coordinator request migration: %w", err)
	}
	return nil
}

func migrateRunSourceSchema(db *sql.DB) error {
	var tableSQL string
	err := db.QueryRow(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runs'`).Scan(&tableSQL)
	if errors.Is(err, sql.ErrNoRows) || strings.Contains(tableSQL, "'project-file'") {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect Run source constraint: %w", err)
	}
	if _, err := db.Exec(`PRAGMA foreign_keys = OFF`); err != nil {
		return fmt.Errorf("disable Run migration foreign keys: %w", err)
	}
	defer func() { _, _ = db.Exec(`PRAGMA foreign_keys = ON`) }()
	if _, err := db.Exec(`PRAGMA legacy_alter_table = ON`); err != nil {
		return fmt.Errorf("enable legacy Run table migration: %w", err)
	}
	defer func() { _, _ = db.Exec(`PRAGMA legacy_alter_table = OFF`) }()
	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin Run source migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	statements := []string{
		`DROP INDEX IF EXISTS idx_runs_session_active`,
		`DROP INDEX IF EXISTS one_open_run_per_session`,
		`DROP INDEX IF EXISTS idx_runs_workstream_created`,
		`ALTER TABLE runs RENAME TO runs_before_v17`,
		`CREATE TABLE runs (
			id                  TEXT PRIMARY KEY CHECK (id LIKE 'run_%'),
			workstream_id       TEXT NOT NULL REFERENCES workstreams(id),
			session_id          TEXT REFERENCES sessions(id),
			notebook_id         TEXT,
			cell_id             TEXT,
			work_node_id        TEXT,
			source_kind         TEXT NOT NULL CHECK (source_kind IN ('work-cell', 'project-file', 'prompt-file', 'promoted-session')),
			execution_target    TEXT NOT NULL,
			status              TEXT NOT NULL CHECK (status IN ('preparing', 'running', 'waiting_permission', 'waiting_input', 'completed', 'cancelled', 'failed', 'interrupted')),
			spec_artifact_id    TEXT NOT NULL REFERENCES artifacts(id),
			context_artifact_id TEXT REFERENCES artifacts(id),
			created_at          INTEGER NOT NULL,
			started_at          INTEGER,
			finished_at         INTEGER,
			failure_reason      TEXT NOT NULL DEFAULT '',
			version             INTEGER NOT NULL DEFAULT 1
		)`,
		`INSERT INTO runs(id, workstream_id, session_id, notebook_id, cell_id, work_node_id, source_kind,
			execution_target, status, spec_artifact_id, context_artifact_id, created_at, started_at, finished_at,
			failure_reason, version)
		 SELECT id, workstream_id, session_id, notebook_id, cell_id, work_node_id, source_kind,
			execution_target, status, spec_artifact_id, context_artifact_id, created_at, started_at, finished_at,
			failure_reason, version FROM runs_before_v17`,
		`DROP TABLE runs_before_v17`,
		`CREATE INDEX idx_runs_session_active ON runs(session_id, status, created_at DESC)`,
		`CREATE UNIQUE INDEX one_open_run_per_session ON runs(session_id)
			WHERE session_id IS NOT NULL AND status IN ('preparing', 'running', 'waiting_permission', 'waiting_input')`,
		`CREATE INDEX idx_runs_workstream_created ON runs(workstream_id, created_at DESC)`,
	}
	for _, statement := range statements {
		if _, err := tx.Exec(statement); err != nil {
			return fmt.Errorf("migrate Run source schema: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Run source migration: %w", err)
	}
	var violation string
	if err := db.QueryRow(`SELECT printf('%s:%s:%s', "table", rowid, parent) FROM pragma_foreign_key_check LIMIT 1`).Scan(&violation); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("verify Run source migration: %w", err)
	} else if violation != "" {
		return fmt.Errorf("Run source migration left foreign-key violation %s", violation)
	}
	return nil
}

func migrateProposalSchema(db *sql.DB) error {
	var tableSQL string
	err := db.QueryRow(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'proposals'`).Scan(&tableSQL)
	if errors.Is(err, sql.ErrNoRows) || (strings.Contains(tableSQL, "'accepting'") &&
		strings.Contains(tableSQL, "'job.create'") && strings.Contains(tableSQL, "'delegation.create'")) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect Proposal status constraint: %w", err)
	}
	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin Proposal status migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	statements := []string{
		`DROP INDEX IF EXISTS idx_proposals_attention`,
		`DROP INDEX IF EXISTS idx_proposals_workstream`,
		`ALTER TABLE proposals RENAME TO proposals_before_v9`,
		`CREATE TABLE proposals (
			id                    TEXT PRIMARY KEY CHECK (id LIKE 'prop_%'),
			client_request_id     TEXT NOT NULL UNIQUE,
			workstream_id         TEXT NOT NULL REFERENCES workstreams(id),
			kind                  TEXT NOT NULL CHECK (kind IN ('cell.create', 'finding.create', 'research_ir.create', 'problem_model.create', 'task.create', 'job.create', 'delegation.create')),
			payload_json          TEXT NOT NULL,
			payload_sha256        TEXT NOT NULL,
			status                TEXT NOT NULL CHECK (status IN ('pending', 'accepting', 'accepted', 'rejected')),
			proposed_by           TEXT NOT NULL,
			source_adapter        TEXT NOT NULL,
			created_at            INTEGER NOT NULL,
			reviewed_by           TEXT NOT NULL DEFAULT '',
			reviewed_at           INTEGER,
			rejection_reason      TEXT NOT NULL DEFAULT '',
			accepted_ref          TEXT NOT NULL DEFAULT '',
			reviewed_payload_json TEXT,
			version               INTEGER NOT NULL DEFAULT 1
		)`,
		`INSERT INTO proposals SELECT * FROM proposals_before_v9`,
		`DROP TABLE proposals_before_v9`,
		`CREATE INDEX idx_proposals_attention ON proposals(status, created_at, id)`,
		`CREATE INDEX idx_proposals_workstream ON proposals(workstream_id, created_at DESC, id DESC)`,
	}
	for _, statement := range statements {
		if _, err := tx.Exec(statement); err != nil {
			return fmt.Errorf("migrate Proposal schema: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Proposal schema migration: %w", err)
	}
	return nil
}

func ensureColumn(db *sql.DB, table, column, statement string) error {
	rows, err := db.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		return fmt.Errorf("inspect research state table %s: %w", table, err)
	}
	found := false
	for rows.Next() {
		var cid int
		var name, kind string
		var notNull, primaryKey int
		var defaultValue any
		if err := rows.Scan(&cid, &name, &kind, &notNull, &defaultValue, &primaryKey); err != nil {
			_ = rows.Close()
			return fmt.Errorf("inspect research state table %s: %w", table, err)
		}
		if name == column {
			found = true
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if found {
		return nil
	}
	if _, err := db.Exec(statement); err != nil {
		return fmt.Errorf("migrate research state column %s.%s: %w", table, column, err)
	}
	return nil
}

func (s *Store) resolve(relPath string) (string, string, error) {
	raw := strings.TrimSpace(relPath)
	if raw == "" || filepath.IsAbs(raw) || strings.HasPrefix(filepath.ToSlash(raw), "/") {
		return "", "", errors.New("research notebook path must be repository-relative")
	}
	clean := filepath.Clean(filepath.FromSlash(raw))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", "", errors.New("research notebook path escapes the repository")
	}
	lower := strings.ToLower(filepath.ToSlash(clean))
	if !strings.HasSuffix(lower, ".noema") && !strings.HasSuffix(lower, ".noema.ipynb") {
		return "", "", errors.New("Noema work documents use the .noema suffix")
	}
	return filepath.Join(s.root, clean), filepath.ToSlash(clean), nil
}

// IndexOptions attributes a reindex to its initiator.
type IndexOptions struct {
	Actor  string `json:"actor"`
	Reason string `json:"reason"`
}

// Event is one durable research event.
type Event struct {
	Seq          int64          `json:"seq"`
	ID           string         `json:"id"`
	Type         string         `json:"type"`
	TS           string         `json:"ts"`
	WorkstreamID string         `json:"workstream_id,omitempty"`
	NotebookID   string         `json:"notebook_id,omitempty"`
	CellID       string         `json:"cell_id,omitempty"`
	WorkNodeID   string         `json:"work_node_id,omitempty"`
	RunID        string         `json:"run_id,omitempty"`
	SessionID    string         `json:"session_id,omitempty"`
	CausationID  string         `json:"causation_id,omitempty"`
	Payload      map[string]any `json:"payload"`
}

// IndexResult describes one notebook reindex.
type IndexResult struct {
	NotebookID    string  `json:"notebookId"`
	WorkstreamID  string  `json:"workstreamId,omitempty"`
	Path          string  `json:"path"`
	Revision      string  `json:"revision"`
	Cells         int     `json:"cells"`
	WorkNodes     int     `json:"workNodes"`
	Edges         int     `json:"edges"`
	DanglingEdges int     `json:"danglingEdges"`
	Unchanged     bool    `json:"unchanged"`
	Events        []Event `json:"events"`
}

// Status compares a notebook file with its indexed revision.
type Status struct {
	Path            string `json:"path"`
	Exists          bool   `json:"exists"`
	FileRevision    string `json:"fileRevision,omitempty"`
	IndexedRevision string `json:"indexedRevision,omitempty"`
	NotebookID      string `json:"notebookId,omitempty"`
	Stale           bool   `json:"stale"`
}

type eventDraft struct {
	typ        string
	cellID     string
	workNodeID string
	payload    map[string]any
}

type relationKey struct {
	cell string
	typ  string
}

// IndexNotebook rebuilds the index of one notebook and records the semantic
// difference from the previous index as events in the same transaction.
func (s *Store) IndexNotebook(relPath string, options IndexOptions) (IndexResult, error) {
	abs, rel, err := s.resolve(relPath)
	if err != nil {
		return IndexResult{}, err
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return IndexResult{}, fmt.Errorf("read research notebook: %w", err)
	}
	notebook, err := ParseNotebook(data)
	if err != nil {
		return IndexResult{}, err
	}
	revision := Revision(data)
	result := IndexResult{
		NotebookID:   notebook.ID,
		WorkstreamID: notebook.WorkstreamID,
		Path:         rel,
		Revision:     revision,
		Cells:        len(notebook.Cells),
		WorkNodes:    len(notebook.WorkNodes),
		Events:       []Event{},
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return IndexResult{}, err
	}
	defer func() { _ = tx.Rollback() }()

	var pathOwner string
	if err := tx.QueryRow(`SELECT id FROM notebooks WHERE path = ?`, rel).Scan(&pathOwner); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return IndexResult{}, err
	}
	if pathOwner != "" && pathOwner != notebook.ID {
		if _, err := tx.Exec(`DELETE FROM notebooks WHERE id = ?`, pathOwner); err != nil {
			return IndexResult{}, err
		}
	}
	var indexedPath, indexedRevision string
	existed := true
	if err := tx.QueryRow(`SELECT path, revision_sha256 FROM notebooks WHERE id = ?`, notebook.ID).Scan(&indexedPath, &indexedRevision); err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return IndexResult{}, err
		}
		existed = false
	}
	if existed && indexedRevision == revision && indexedPath == rel {
		result.Unchanged = true
		if err := tx.QueryRow(`SELECT COUNT(*) FROM work_dependencies WHERE notebook_id = ?`, notebook.ID).Scan(&result.Edges); err != nil {
			return IndexResult{}, err
		}
		return result, tx.Commit()
	}

	oldCells := map[string]Cell{}
	oldRelations := map[relationKey]map[string]bool{}
	if existed {
		if oldCells, err = loadCells(tx, notebook.ID); err != nil {
			return IndexResult{}, err
		}
		if oldRelations, err = loadRelations(tx, notebook.ID); err != nil {
			return IndexResult{}, err
		}
	}

	now := time.Now()
	nowMs := now.UnixMilli()
	if existed {
		_, err = tx.Exec(`UPDATE notebooks SET path = ?, workstream_id = ?, title = ?, revision_sha256 = ?, indexed_at = ? WHERE id = ?`,
			rel, nullable(notebook.WorkstreamID), notebook.Title, revision, nowMs, notebook.ID)
	} else {
		_, err = tx.Exec(`INSERT INTO notebooks(id, path, workstream_id, title, revision_sha256, indexed_at) VALUES(?, ?, ?, ?, ?, ?)`,
			notebook.ID, rel, nullable(notebook.WorkstreamID), notebook.Title, revision, nowMs)
	}
	if err != nil {
		return IndexResult{}, err
	}
	if strings.HasPrefix(notebook.WorkstreamID, "ws_") {
		if _, err := tx.Exec(`INSERT INTO workstreams(id, title, notebook_id, status, created_at, updated_at) VALUES(?, ?, ?, 'active', ?, ?)
			ON CONFLICT(id) DO UPDATE SET title = excluded.title, notebook_id = excluded.notebook_id,
				updated_at = excluded.updated_at, version = workstreams.version + 1`,
			notebook.WorkstreamID, notebook.Title, notebook.ID, nowMs, nowMs); err != nil {
			return IndexResult{}, err
		}
	}
	if _, err := tx.Exec(`DELETE FROM cells WHERE notebook_id = ?`, notebook.ID); err != nil {
		return IndexResult{}, err
	}
	if _, err := tx.Exec(`DELETE FROM work_dependencies WHERE notebook_id = ?`, notebook.ID); err != nil {
		return IndexResult{}, err
	}
	if _, err := tx.Exec(`DELETE FROM work_nodes WHERE notebook_id = ?`, notebook.ID); err != nil {
		return IndexResult{}, err
	}
	if _, err := tx.Exec(`DELETE FROM edges WHERE notebook_id = ?`, notebook.ID); err != nil {
		return IndexResult{}, err
	}

	for _, node := range notebook.WorkNodes {
		if _, err := tx.Exec(`INSERT INTO work_nodes(notebook_id, work_node_id, kind, title, state, outcome, dropped_reason, disclosure, agenda_json)
			VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`, notebook.ID, node.ID, node.Kind, node.Title, node.State,
			node.Outcome, node.DroppedReason, node.Disclosure, string(node.Agenda)); err != nil {
			return IndexResult{}, err
		}
	}
	newRelations := map[relationKey]map[string]bool{}
	for _, cell := range notebook.Cells {
		if _, err := tx.Exec(`INSERT INTO cells(notebook_id, cell_id, cell_type, kind, title, state, outcome, dropped_reason, result_of, ordinal, source_sha256,
			outputs_sha256, latest_output, latest_run_id, output_status, output_agent)
			VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			notebook.ID, cell.ID, cell.CellType, cell.Kind, cell.Title, cell.State, cell.Outcome,
			cell.DroppedReason, cell.Of, cell.Ordinal, cell.SourceSHA256, cell.OutputsSHA256,
			cell.LatestOutput, cell.LatestRunID, cell.OutputStatus, cell.OutputAgent); err != nil {
			return IndexResult{}, err
		}
		if cell.WorkNodeID != "" {
			if _, err := tx.Exec(`INSERT INTO cell_work_nodes(notebook_id, cell_id, work_node_id) VALUES(?, ?, ?)`,
				notebook.ID, cell.ID, cell.WorkNodeID); err != nil {
				return IndexResult{}, err
			}
		}
	}
	for _, edge := range notebook.Dependencies {
		if workNodeByID(notebook.WorkNodes, edge.From) == nil || workNodeByID(notebook.WorkNodes, edge.To) == nil || edge.From == edge.To {
			result.DanglingEdges++
			continue
		}
		if _, err := tx.Exec(`INSERT INTO work_dependencies(notebook_id, dependency_id, src_work_node_id, dst_work_node_id, type, notebook_revision)
			VALUES(?, ?, ?, ?, ?, ?)`, notebook.ID, edge.ID, edge.From, edge.To, edge.Type, revision); err != nil {
			return IndexResult{}, err
		}
		key := relationKey{cell: edge.To, typ: edge.Type}
		if newRelations[key] == nil {
			newRelations[key] = map[string]bool{}
		}
		newRelations[key][edge.From] = true
		result.Edges++
	}

	drafts := diffEvents(existed, notebook, oldCells, oldRelations, newRelations)
	for _, draft := range drafts {
		payload := map[string]any{"revision": revision}
		if options.Actor != "" {
			payload["actor"] = options.Actor
		}
		if options.Reason != "" {
			payload["reason"] = options.Reason
		}
		for key, value := range draft.payload {
			payload[key] = value
		}
		eventUUID, err := uuid.NewV7()
		if err != nil {
			return IndexResult{}, err
		}
		id := "evt_" + eventUUID.String()
		payloadJSON, err := json.Marshal(payload)
		if err != nil {
			return IndexResult{}, err
		}
		inserted, err := tx.Exec(`INSERT INTO events(id, type, ts, workstream_id, notebook_id, cell_id, work_node_id, payload_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
			id, draft.typ, nowMs, nullable(notebook.WorkstreamID), notebook.ID, nullable(draft.cellID), nullable(draft.workNodeID), string(payloadJSON))
		if err != nil {
			return IndexResult{}, err
		}
		seq, err := inserted.LastInsertId()
		if err != nil {
			return IndexResult{}, err
		}
		result.Events = append(result.Events, Event{
			Seq:          seq,
			ID:           id,
			Type:         draft.typ,
			TS:           formatMillis(nowMs),
			WorkstreamID: notebook.WorkstreamID,
			NotebookID:   notebook.ID,
			CellID:       draft.cellID,
			WorkNodeID:   draft.workNodeID,
			Payload:      payload,
		})
	}
	if err := tx.Commit(); err != nil {
		return IndexResult{}, err
	}
	return result, nil
}

func workNodeByID(nodes []WorkNode, id string) *WorkNode {
	for index := range nodes {
		if nodes[index].ID == id {
			return &nodes[index]
		}
	}
	return nil
}

func diffEvents(existed bool, notebook Notebook, oldCells map[string]Cell,
	oldRelations, newRelations map[relationKey]map[string]bool) []eventDraft {
	if !existed {
		return []eventDraft{{typ: "research.notebook.indexed", payload: map[string]any{
			"cells": len(notebook.Cells), "work_nodes": len(notebook.WorkNodes),
			"title": notebook.Title,
		}}}
	}
	var drafts []eventDraft
	current := make(map[string]bool, len(notebook.Cells))
	for _, cell := range notebook.Cells {
		current[cell.ID] = true
	}
	removed := make([]Cell, 0)
	for id, cell := range oldCells {
		if !current[id] {
			removed = append(removed, cell)
		}
	}
	sort.Slice(removed, func(i, j int) bool { return removed[i].Ordinal < removed[j].Ordinal })
	for _, cell := range removed {
		drafts = append(drafts, eventDraft{typ: "research.cell.deleted", cellID: cell.ID, workNodeID: cell.WorkNodeID,
			payload: map[string]any{"kind": cell.Kind, "title": cell.Title}})
	}
	for _, cell := range notebook.Cells {
		old, ok := oldCells[cell.ID]
		if !ok {
			drafts = append(drafts, eventDraft{typ: "research.cell.created", cellID: cell.ID, workNodeID: cell.WorkNodeID, payload: map[string]any{
				"kind": cell.Kind, "title": cell.Title, "lineage": cell.Lineage, "depends": cell.Depends,
			}})
			continue
		}
		var fields []string
		if old.Kind != cell.Kind {
			fields = append(fields, "kind")
		}
		if old.CellType != cell.CellType {
			fields = append(fields, "cell_type")
		}
		if old.Title != cell.Title {
			fields = append(fields, "title")
		}
		if old.SourceSHA256 != cell.SourceSHA256 {
			fields = append(fields, "source")
		}
		if old.OutputsSHA256 != cell.OutputsSHA256 {
			fields = append(fields, "outputs")
		}
		if len(fields) > 0 {
			drafts = append(drafts, eventDraft{typ: "research.cell.updated", cellID: cell.ID, workNodeID: cell.WorkNodeID,
				payload: map[string]any{"fields": fields, "kind": cell.Kind, "title": cell.Title}})
		}
		if old.State != cell.State || old.Outcome != cell.Outcome {
			payload := map[string]any{"from": old.State, "to": cell.State, "outcome_from": old.Outcome, "outcome_to": cell.Outcome}
			if cell.State == "dropped" && cell.DroppedReason != "" {
				payload["reason_text"] = cell.DroppedReason
			}
			drafts = append(drafts, eventDraft{typ: "research.cell.state_changed", cellID: cell.ID, workNodeID: cell.WorkNodeID, payload: payload})
		}
		for _, typ := range []string{"lineage", "depends"} {
			key := relationKey{cell: cell.WorkNodeID, typ: typ}
			added, dropped := setDifference(newRelations[key], oldRelations[key]), setDifference(oldRelations[key], newRelations[key])
			if len(added) > 0 || len(dropped) > 0 {
				drafts = append(drafts, eventDraft{typ: "research.relation.changed", cellID: cell.ID, workNodeID: cell.WorkNodeID,
					payload: map[string]any{"type": typ, "added": added, "removed": dropped}})
			}
		}
	}
	if len(drafts) == 0 {
		drafts = append(drafts, eventDraft{typ: "research.index.rebuilt", payload: map[string]any{"cells": len(notebook.Cells)}})
	}
	return drafts
}

func setDifference(left, right map[string]bool) []string {
	out := []string{}
	for value := range left {
		if !right[value] {
			out = append(out, value)
		}
	}
	sort.Strings(out)
	return out
}

func loadCells(tx *sql.Tx, notebookID string) (map[string]Cell, error) {
	rows, err := tx.Query(`SELECT c.cell_id, c.cell_type, c.kind, c.title, c.state, c.outcome, c.dropped_reason,
		c.result_of, c.ordinal, c.source_sha256, c.outputs_sha256, c.latest_output, c.latest_run_id,
		c.output_status, c.output_agent, COALESCE(b.work_node_id, '')
		FROM cells c LEFT JOIN cell_work_nodes b ON b.notebook_id = c.notebook_id AND b.cell_id = c.cell_id
		WHERE c.notebook_id = ?`, notebookID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cells := map[string]Cell{}
	for rows.Next() {
		var cell Cell
		if err := rows.Scan(&cell.ID, &cell.CellType, &cell.Kind, &cell.Title, &cell.State, &cell.Outcome,
			&cell.DroppedReason, &cell.Of, &cell.Ordinal, &cell.SourceSHA256, &cell.OutputsSHA256,
			&cell.LatestOutput, &cell.LatestRunID, &cell.OutputStatus, &cell.OutputAgent, &cell.WorkNodeID); err != nil {
			return nil, err
		}
		cells[cell.ID] = cell
	}
	return cells, rows.Err()
}

func loadRelations(tx *sql.Tx, notebookID string) (map[relationKey]map[string]bool, error) {
	rows, err := tx.Query(`SELECT src_work_node_id, dst_work_node_id, type FROM work_dependencies WHERE notebook_id = ?`, notebookID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	relations := map[relationKey]map[string]bool{}
	for rows.Next() {
		var src, dst, typ string
		if err := rows.Scan(&src, &dst, &typ); err != nil {
			return nil, err
		}
		key := relationKey{cell: dst, typ: typ}
		if relations[key] == nil {
			relations[key] = map[string]bool{}
		}
		relations[key][src] = true
	}
	return relations, rows.Err()
}

// Status reports whether a notebook file differs from its indexed revision.
func (s *Store) Status(relPath string) (Status, error) {
	abs, rel, err := s.resolve(relPath)
	if err != nil {
		return Status{}, err
	}
	status := Status{Path: rel}
	data, err := os.ReadFile(abs)
	if err != nil && !os.IsNotExist(err) {
		return Status{}, err
	}
	if err == nil {
		status.Exists = true
		status.FileRevision = Revision(data)
	}
	if err := s.db.QueryRow(`SELECT id, revision_sha256 FROM notebooks WHERE path = ?`, rel).
		Scan(&status.NotebookID, &status.IndexedRevision); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return Status{}, err
	}
	status.Stale = status.Exists && status.FileRevision != status.IndexedRevision
	return status, nil
}

// Events lists events after seq, optionally limited to one notebook.
// LatestWorkNodeActivity returns one event per WorkNode of NOTEBOOK-ID carrying
// its newest event time and sequence.  Projections that only need "last
// activity" read this instead of paging the notebook's oldest events.
func (s *Store) LatestWorkNodeActivity(notebookID string) ([]Event, error) {
	query := `SELECT work_node_id, MAX(ts), MAX(seq) FROM events WHERE COALESCE(work_node_id, '') != ''`
	args := []any{}
	if notebookID != "" {
		query += ` AND notebook_id = ?`
		args = append(args, notebookID)
	}
	rows, err := s.db.Query(query+` GROUP BY work_node_id ORDER BY MAX(seq)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := []Event{}
	for rows.Next() {
		var event Event
		var ts int64
		if err := rows.Scan(&event.WorkNodeID, &ts, &event.Seq); err != nil {
			return nil, err
		}
		event.Type, event.NotebookID, event.TS, event.Payload = "work-node.activity", notebookID, formatMillis(ts), map[string]any{}
		events = append(events, event)
	}
	return events, rows.Err()
}

func (s *Store) Events(notebookID string, after int64, limit int) ([]Event, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	query := `SELECT seq, id, type, ts, COALESCE(workstream_id, ''), COALESCE(notebook_id, ''), COALESCE(cell_id, ''), COALESCE(work_node_id, ''),
		COALESCE(run_id, ''), COALESCE(session_id, ''), COALESCE(causation_id, ''), payload_json
		FROM events WHERE seq > ?`
	args := []any{after}
	if notebookID != "" {
		query += ` AND notebook_id = ?`
		args = append(args, notebookID)
	}
	query += ` ORDER BY seq LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := []Event{}
	for rows.Next() {
		var event Event
		var ts int64
		var payload string
		if err := rows.Scan(&event.Seq, &event.ID, &event.Type, &ts, &event.WorkstreamID, &event.NotebookID, &event.CellID, &event.WorkNodeID,
			&event.RunID, &event.SessionID, &event.CausationID, &payload); err != nil {
			return nil, err
		}
		event.TS = formatMillis(ts)
		if err := json.Unmarshal([]byte(payload), &event.Payload); err != nil {
			event.Payload = map[string]any{}
		}
		events = append(events, event)
	}
	return events, rows.Err()
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func formatMillis(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z07:00")
}
