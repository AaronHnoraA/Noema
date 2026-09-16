package research

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestWorkAgendaProjectionAndIndex(t *testing.T) {
	store, root := openTestStore(t)
	data := []byte(`{"nbformat":4,"nbformat_minor":5,"metadata":{"noema_research":{
 "schema":"noema.work-document/2","notebook_id":"nb_agenda","work_nodes":[
 {"id":"wn_work","kind":"work","title":"Proof","state":"open"},
 {"id":"wn_review","kind":"checkpoint","title":"Review"}],
 "dependencies":[{"id":"dep_a","from":"wn_work","to":"wn_review","type":"depends"}]}},"cells":[
 {"id":"c_work","cell_type":"code","execution_count":null,"outputs":[],"metadata":{"noema_research":{"work_node_id":"wn_work"}},"source":"@@todo [Proof] {\n  sche: 2026-09-15 09:00\n  prio: A\n  progress: 37.5\n}\n@@clock [Proof] {id=clock_a, from=\"2026-09-16 09:00\", to=\"2026-09-16 10:15\"}\n\nProve it."},
 {"id":"c_review","cell_type":"markdown","metadata":{"noema_research":{"work_node_id":"wn_review"}},"source":"@@todo [Review] {}\n\nReview it."}]}`)
	notebook, err := ParseNotebook(data)
	if err != nil {
		t.Fatal(err)
	}
	if string(notebook.WorkNodes[1].Agenda) != "{}" {
		t.Fatal("empty Agenda inclusion was discarded")
	}
	encoded, err := json.Marshal(notebook)
	if err != nil {
		t.Fatal(err)
	}
	var roundtrip Notebook
	if err := json.Unmarshal(encoded, &roundtrip); err != nil {
		t.Fatal(err)
	}
	if string(roundtrip.WorkNodes[0].Agenda) != string(notebook.WorkNodes[0].Agenda) {
		t.Fatal("projection lost Agenda")
	}
	if err := os.WriteFile(filepath.Join(root, "work.noema"), data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.IndexNotebook("work.noema", IndexOptions{}); err != nil {
		t.Fatal(err)
	}
	var agenda string
	if err := store.db.QueryRow(`SELECT agenda_json FROM work_nodes WHERE work_node_id='wn_review'`).Scan(&agenda); err != nil {
		t.Fatal(err)
	}
	if agenda != "{}" {
		t.Fatalf("index lost Agenda inclusion: %q", agenda)
	}
	if err := store.db.QueryRow(`SELECT agenda_json FROM work_nodes WHERE work_node_id='wn_work'`).Scan(&agenda); err != nil {
		t.Fatal(err)
	}
	var expected, stored map[string]any
	if err := json.Unmarshal(notebook.WorkNodes[0].Agenda, &expected); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(agenda), &stored); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(expected, stored) {
		t.Fatalf("index lost native clock/progress: %s", agenda)
	}
}

func TestWorkAgendaRejectsHiddenNodeMetadata(t *testing.T) {
	data := []byte(`{"nbformat":4,"nbformat_minor":5,"metadata":{"noema_research":{"schema":"noema.work-document/2","notebook_id":"nb_hidden","work_nodes":[{"id":"wn_work","kind":"work","title":"Proof","state":"open","agenda":{}}],"dependencies":[]}},"cells":[]}`)
	if _, err := ParseNotebook(data); err == nil {
		t.Fatal("accepted hidden WorkNode Agenda metadata")
	}
}

func TestWorkAgendaValidation(t *testing.T) {
	for _, raw := range []string{`null`, `[]`, `{"sche":"yesterday"}`, `{"prio":"urgent"}`, `{"effort":"nonsense"}`, `{"status":"done"}`, `{"repeat":"+1d"}`, `{"agent":"codex"}`, `{"sche":null}`} {
		if err := validateWorkAgenda(json.RawMessage(raw), "work"); err == nil {
			t.Errorf("accepted invalid Agenda: %s", raw)
		}
	}
	for _, raw := range []string{`{}`, `{"effort":"0m","sche":"2026-09-15","project":"Proof"}`} {
		if err := validateWorkAgenda(json.RawMessage(raw), "work"); err != nil {
			t.Errorf("rejected Agenda %s: %v", raw, err)
		}
	}
}

func TestWorkAgendaClockAndProgressValidation(t *testing.T) {
	for _, raw := range []string{
		`{"clocks":null}`, `{"clocks":{}}`, `{"clocks":[null]}`, `{"clocks":[{}]}`,
		`{"clocks":[{"id":"a","from":"2026-02-30 09:00"}]}`,
		`{"clocks":[{"id":"a","from":"2026-09-16"}]}`,
		`{"clocks":[{"id":"a","from":"2026-09-16 09:00","to":null}]}`,
		`{"clocks":[{"id":"a","from":"2026-09-16 09:00","to":"2026-09-16 08:00"}]}`,
		`{"clocks":[{"id":"a","from":"2026-09-16 09:00"},{"id":"b","from":"2026-09-16 10:00"}]}`,
		`{"clocks":[{"id":"a","from":"2026-09-16 09:00","to":"2026-09-16 10:00"},{"id":"a","from":"2026-09-16 10:00"}]}`,
		`{"progress":"-1"}`, `{"progress":"101"}`, `{"progress":50}`, `{"progress":"1e2"}`,
	} {
		if err := validateWorkAgenda(json.RawMessage(raw), "work"); err == nil {
			t.Errorf("accepted invalid Agenda: %s", raw)
		}
	}
	if err := validateWorkAgenda(json.RawMessage(`{"progress":"37.5","clocks":[{"id":"a","from":"2026-09-16 09:00","to":"2026-09-16 10:15"},{"id":"b","from":"2026-09-16 10:15"}]}`), "work"); err != nil {
		t.Fatal(err)
	}
}
