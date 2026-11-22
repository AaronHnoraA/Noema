package wikiindex

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"

	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// The scanner: the vault's repositories, their files and their pages, as
// Node's discoverWikiRepositories, repositoryFileInventory and noteForFile
// build them for a full (uncached) index.

var (
	partitions         = []string{"public", "private"}
	ignoredDirectories = map[string]bool{".git": true, ".direnv": true, ".lake": true, ".noema": true, ".agent": true,
		".venv": true, "node_modules": true, "__pycache__": true, ".ipynb_checkpoints": true, ".pytest_cache": true,
		".mypy_cache": true, ".ruff_cache": true}
	noteExtensions    = map[string]bool{".md": true, ".markdown": true}
	manifestSchemaRE  = regexp.MustCompile(`(?m)^\s*schema\s*=\s*(\d+)\s*$`)
	manifestIDRE      = regexp.MustCompile(`(?m)^\s*repository_id\s*=\s*["']([^"']+)["']\s*$`)
	manifestNSRE      = regexp.MustCompile(`(?m)^\s*namespace\s*=\s*["']([^"']+)["']\s*$`)
	manifestAliasesRE = regexp.MustCompile(`(?m)^\s*namespace_aliases\s*=\s*(.+?)\s*$`)
	dependencyLinkRE  = regexp.MustCompile(`!?\[[^\]\n]*\]\(((?:[^()\n]|\([^()\n]*\))+)\)`)
	includeRE         = regexp.MustCompile(`(?im)^\s*#\+include:\s+([^\n]+)$`)
	dependencySkipRE  = regexp.MustCompile(`(?i)^(?:[a-z][a-z0-9+.-]*:|#|@@)`)
	createdDateRE     = regexp.MustCompile(`^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])`)
)

func provisionalKey(values ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(values, "\x00")))
	return "provisional:" + hex.EncodeToString(sum[:])[:24]
}

func uniqueNamespaces(values ...string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, value := range values {
		value = NormalizeNamespace(value)
		if value != "" && !seen[value] {
			seen[value] = true
			out = append(out, value)
		}
	}
	return out
}

// discover finds the indexed repositories and the diagnostics for the rest.
func discover(root string) ([]IndexRepository, []Diagnostic) {
	repositories := []IndexRepository{}
	diagnostics := []Diagnostic{}
	for _, partition := range partitions {
		partitionRoot := filepath.Join(root, partition)
		entries, err := os.ReadDir(partitionRoot)
		if err != nil {
			diagnostics = append(diagnostics, Diagnostic{Code: "missing-partition", Severity: "info",
				Path: partitionRoot, Message: "Missing " + partition + "/ directory"})
			continue
		}
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".") || !entry.IsDir() {
				continue
			}
			path := filepath.Join(partitionRoot, entry.Name())
			if _, err := os.Stat(filepath.Join(path, ".git")); err != nil {
				diagnostics = append(diagnostics, Diagnostic{Code: "non-git-directory", Severity: "warning", Path: path,
					Message: partition + "/" + entry.Name() + " is not indexed because it is not a Git repository"})
				continue
			}
			manifestFile := filepath.Join(path, "noema.toml")
			manifest, _ := os.ReadFile(manifestFile)
			text := string(manifest)
			schema, id, namespace := 0, "", ""
			if m := manifestSchemaRE.FindStringSubmatch(text); m != nil {
				schema, _ = strconv.Atoi(m[1])
			}
			if m := manifestIDRE.FindStringSubmatch(text); m != nil {
				id = strings.TrimSpace(m[1])
			}
			if m := manifestNSRE.FindStringSubmatch(text); m != nil {
				namespace = NormalizeNamespace(m[1])
			}
			aliases := []string{}
			if m := manifestAliasesRE.FindStringSubmatch(text); m != nil {
				aliases = parseList(m[1])
			}
			managed := schema == 1 && uuidV7RE.MatchString(id)
			uid := id
			if uid == "" {
				uid = provisionalKey("repository", partition, entry.Name())
			}
			status := "provisional"
			if managed {
				status = "managed"
			} else {
				diagnostics = append(diagnostics, Diagnostic{Code: "missing-repository-manifest", Severity: "warning",
					Path: manifestFile, Message: partition + "/" + entry.Name() + " needs a committed noema.toml before its repository identity can be shared"})
			}
			if namespace == "" {
				namespace = NormalizeNamespace(entry.Name())
			}
			repositories = append(repositories, IndexRepository{ID: partition + "/" + entry.Name(), UID: uid,
				IdentityStatus: status, Name: entry.Name(), Namespace: namespace,
				QualifiedNamespace: partition + "/" + namespace,
				NamespaceAliases:   uniqueNamespaces(append([]string{entry.Name()}, aliases...)...),
				Partition:          partition, Path: path, Public: partition == "public"})
		}
	}
	return repositories, diagnostics
}

func walkFiles(root string) []string {
	files := []string{}
	var walk func(dir string)
	walk = func(dir string) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, entry := range entries {
			if entry.IsDir() && ignoredDirectories[entry.Name()] {
				continue
			}
			if entry.Type().IsRegular() && entry.Name() == ".DS_Store" {
				continue
			}
			path := filepath.Join(dir, entry.Name())
			if entry.IsDir() {
				walk(path)
			} else if entry.Type().IsRegular() {
				files = append(files, path)
			}
		}
	}
	walk(root)
	return files
}

func gitStatuses(repository string) map[string]string {
	statuses := map[string]string{}
	out, err := exec.Command("git", "-C", repository, "status", "--porcelain=v1", "-z", "--untracked-files=all").Output()
	if err != nil {
		return statuses
	}
	entries := strings.Split(string(out), "\x00")
	for index := 0; index < len(entries); index++ {
		entry := entries[index]
		if len(entry) < 4 {
			continue
		}
		code := entry[:2]
		status := strings.TrimSpace(code)
		if status == "" {
			status = "clean"
		}
		statuses[entry[3:]] = status
		if strings.ContainsAny(code, "RC") && index+1 < len(entries) && entries[index+1] != "" {
			index++
		}
	}
	return statuses
}

func mtimeMs(info os.FileInfo) float64 {
	t := info.ModTime()
	return float64(t.Unix())*1000 + float64(t.Nanosecond())/1e6
}

func inside(root, target string) bool {
	rel, err := filepath.Rel(root, target)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

func dependencyCandidates(content, noteFile string, repository IndexRepository) []depCandidate {
	out := []depCandidate{}
	add := func(raw, kind string) {
		value := strings.TrimSpace(raw)
		value = strings.TrimPrefix(strings.TrimPrefix(value, `"`), "<")
		value = strings.TrimSuffix(strings.TrimSuffix(value, `"`), ">")
		if value == "" || dependencySkipRE.MatchString(value) {
			return
		}
		target := value
		if cut := strings.IndexAny(target, "?#"); cut >= 0 {
			target = target[:cut]
		}
		file := filepath.Clean(filepath.Join(filepath.Dir(noteFile), target))
		if !inside(repository.Path, file) {
			out = append(out, depCandidate{kind: kind, raw: value, outside: true})
			return
		}
		rel, _ := filepath.Rel(repository.Path, file)
		out = append(out, depCandidate{kind: kind, raw: value, file: file, rel: filepath.ToSlash(rel)})
	}
	for _, m := range dependencyLinkRE.FindAllStringSubmatch(content, -1) {
		add(m[1], "asset")
	}
	for _, m := range includeRE.FindAllStringSubmatch(content, -1) {
		add(m[1], "include")
	}
	return out
}

// dependencyRefs are a page's dependencies with their files' current status.
func dependencyRefs(candidates []depCandidate, exists func(string) bool) []Dependency {
	refs := []Dependency{}
	for _, c := range candidates {
		if c.outside {
			refs = append(refs, Dependency{Kind: c.kind, Raw: c.raw, Status: "outside-repository", Path: ""})
			continue
		}
		status := "missing"
		if exists(c.file) {
			status = "resolved"
		}
		refs = append(refs, Dependency{Kind: c.kind, Raw: c.raw, Status: status, Path: c.rel})
	}
	return refs
}

// createdTime is local midnight of a `date: YYYY-MM-DD` value, as
// knowledgeCreatedTime computes it; zero for anything else.
func createdTime(value string) float64 {
	m := createdDateRE.FindStringSubmatch(strings.TrimSpace(value))
	if m == nil {
		return 0
	}
	year, _ := strconv.Atoi(m[1])
	month, _ := strconv.Atoi(m[2])
	day, _ := strconv.Atoi(m[3])
	if month < 1 || month > 12 || day < 1 || day > 31 {
		return 0
	}
	bound := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.Local)
	if int(bound.Month()) != month {
		return 0
	}
	return float64(bound.UnixMilli())
}

func jsNumber(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}

func generation(idx Index) string {
	digest := sha256.New()
	digest.Write([]byte("wiki"))
	for _, repo := range idx.Repositories {
		fmt.Fprintf(digest, "\x00r:%s:%s", repo.UID, repo.IdentityStatus)
	}
	for _, file := range idx.Files {
		fmt.Fprintf(digest, "\x00f:%s:%s:%s:%s", file.RepositoryUID, file.RepositoryPath, jsNumber(file.Size), jsNumber(file.MtimeMs))
	}
	return hex.EncodeToString(digest.Sum(nil))[:20]
}

// Scan builds the full index of the vault at ROOT from its files.
func Scan(root string) (Index, error) {
	scanMu.Lock()
	defer scanMu.Unlock()
	root, err := filepath.Abs(root)
	if err != nil {
		return Index{}, err
	}
	repositories, diagnostics := discover(root)
	idx := Index{Repositories: repositories, Files: []IndexFile{}, Notes: []IndexNote{}}
	// Git is asked about every repository at once: two processes each.
	statusesByRepo := make([]map[string]string, len(repositories))
	var wait sync.WaitGroup
	for index := range repositories {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			if out, err := exec.Command("git", "-C", repositories[index].Path, "rev-parse", "HEAD").Output(); err == nil {
				repositories[index].HeadSHA = strings.TrimSpace(string(out))
			}
			statusesByRepo[index] = gitStatuses(repositories[index].Path)
		}(index)
	}
	wait.Wait()
	idx.Repositories = repositories
	// Every file of every repository, then their metadata in parallel: one
	// stat each, as many at once as the machine runs well.
	type found struct {
		repo     int
		file     string
		info     os.FileInfo
		statuses map[string]string
	}
	files := []found{}
	for repoIndex, repo := range repositories {
		for _, file := range walkFiles(repo.Path) {
			files = append(files, found{repo: repoIndex, file: file, statuses: statusesByRepo[repoIndex]})
		}
	}
	parallel(len(files), func(index int) {
		if info, err := os.Stat(files[index].file); err == nil {
			files[index].info = info
		}
	})
	seen := map[string]bool{}
	type pendingNote struct {
		repo  IndexRepository
		entry IndexFile
	}
	notes := []pendingNote{}
	depFiles := map[string]bool{}
	for _, item := range files {
		if item.info == nil {
			continue
		}
		repo := repositories[item.repo]
		rel, _ := filepath.Rel(repo.Path, item.file)
		rel = filepath.ToSlash(rel)
		ext := strings.ToLower(jsExtname(item.file))
		kind := "file"
		if noteExtensions[ext] {
			kind = "note"
		}
		status := item.statuses[rel]
		if status == "" {
			status = "clean"
		}
		entry := IndexFile{RepositoryID: repo.ID, RepositoryUID: repo.UID, Partition: repo.Partition,
			Path: repo.ID + "/" + rel, Name: filepath.Base(item.file), RepositoryPath: rel, File: item.file,
			Kind: kind, Ext: strings.TrimPrefix(ext, "."), Size: float64(item.info.Size()), MtimeMs: mtimeMs(item.info), GitStatus: status}
		idx.Files = append(idx.Files, entry)
		if kind != "note" {
			continue
		}
		if cached, ok := cachedParse(entry, repo); ok {
			seen[item.file] = true
			notes = append(notes, pendingNote{repo: repo, entry: entry})
			for _, dep := range cached.deps {
				if !dep.outside {
					depFiles[dep.file] = true
				}
			}
		}
	}
	// Whether each dependency exists, asked once per file and in parallel.
	depList := make([]string, 0, len(depFiles))
	for file := range depFiles {
		depList = append(depList, file)
	}
	present := make([]bool, len(depList))
	parallel(len(depList), func(index int) {
		_, err := os.Stat(depList[index])
		present[index] = err == nil
	})
	existing := make(map[string]bool, len(depList))
	for index, file := range depList {
		existing[file] = present[index]
	}
	exists := func(file string) bool { return existing[file] }
	for _, pending := range notes {
		if note, ok := scanNote(root, pending.repo, pending.entry, exists); ok {
			idx.Notes = append(idx.Notes, note)
		}
	}
	for file := range parseCache {
		if !seen[file] {
			delete(parseCache, file)
		}
	}
	pages := make([]Page, len(idx.Notes))
	for index, note := range idx.Notes {
		pages[index] = note.Page
	}
	relations := Resolve(pages)
	for _, note := range idx.Notes {
		for _, id := range note.DuplicateBlockIDs {
			path := note.Path
			if path == "" {
				path = note.File
			}
			diagnostics = append(diagnostics, Diagnostic{Code: "duplicate-block-id", Severity: "error", Path: path,
				Message: "Block id " + id + " occurs more than once in " + note.Title})
		}
	}
	for _, missing := range relations.Reports.MissingFragments {
		diagnostics = append(diagnostics, Diagnostic{Code: "missing-block-id", Severity: "warning", Path: missing.SourceFile,
			Message: "Block target " + missing.Fragment + " was not found"})
	}
	diagnostics = append(diagnostics, duplicatePageIDDiagnostics(relations.Reports.DuplicateIDs)...)
	idx.Diagnostics = diagnostics
	idx.Generation = generation(idx)
	return idx, nil
}

func duplicatePageIDDiagnostics(duplicates []DuplicateID) []Diagnostic {
	order := []string{}
	files := map[string][]string{}
	seen := map[string]map[string]bool{}
	for _, duplicate := range duplicates {
		if _, ok := files[duplicate.ID]; !ok {
			order = append(order, duplicate.ID)
			seen[duplicate.ID] = map[string]bool{}
		}
		for _, candidate := range duplicate.Candidates {
			if candidate.File != "" && !seen[duplicate.ID][candidate.File] {
				seen[duplicate.ID][candidate.File] = true
				files[duplicate.ID] = append(files[duplicate.ID], candidate.File)
			}
		}
	}
	out := []Diagnostic{}
	for _, id := range order {
		list := files[id]
		path := ""
		if len(list) > 0 {
			path = list[0]
		}
		out = append(out, Diagnostic{Code: "duplicate-page-id", Severity: "error", Path: path,
			Message: fmt.Sprintf("Page id %s is present in %d files: %s", id, len(list), strings.Join(list, ", "))})
	}
	return out
}

// parsedFile is what a file's text alone gives, kept while the file's size
// and modification time stay the same (Node's note_cache plays this role).
type parsedFile struct {
	size, mtime float64
	note        Note
	approved    string
	meta        map[string]string
	deps        []depCandidate
	depsRepo    string
}

// depCandidate is a dependency as the text names it; whether its file exists
// is asked on every scan.
type depCandidate struct {
	kind, raw, file, rel string
	outside              bool
}

var (
	parseCache = map[string]parsedFile{}
	scanMu     sync.Mutex
)

func cachedParse(file IndexFile, repo IndexRepository) (parsedFile, bool) {
	if hit, ok := parseCache[file.File]; ok && hit.size == file.Size && hit.mtime == file.MtimeMs && hit.depsRepo == repo.Path {
		return hit, true
	}
	content, err := os.ReadFile(file.File)
	if err != nil {
		return parsedFile{}, false
	}
	note, approved, meta := parseNote(string(content), file.File)
	entry := parsedFile{size: file.Size, mtime: file.MtimeMs, note: note, approved: approved, meta: meta,
		deps: dependencyCandidates(approved, file.File, repo), depsRepo: repo.Path}
	parseCache[file.File] = entry
	return entry, true
}

func scanNote(root string, repo IndexRepository, file IndexFile, exists func(string) bool) (IndexNote, bool) {
	cached, ok := cachedParse(file, repo)
	if !ok {
		return IndexNote{}, false
	}
	parsed, approved, meta := cached.note, cached.approved, cached.meta
	namespace := NormalizeNamespace(firstNonEmpty(meta["namespace"], repo.Namespace, repo.Name))
	qualifiedNS := repo.Partition + "/" + namespace
	id := parsed.PersistedID
	if id == "" {
		id = provisionalKey(firstNonEmpty(repo.UID, repo.ID), file.RepositoryPath)
	}
	nsValues := append([]string{}, parsed.PageNamespaceAliases...)
	source := "repository"
	if meta["namespace"] != "" {
		source = "page"
	} else {
		nsValues = append(nsValues, repo.Name, repo.ID, repo.QualifiedNamespace)
		nsValues = append(nsValues, repo.NamespaceAliases...)
	}
	kind := meta["kind"]
	if kind == "" {
		kind = "page"
	}
	workspacePath, _ := filepath.Rel(root, file.File)
	workspacePath = filepath.ToSlash(workspacePath)
	note := IndexNote{
		Page: Page{
			ID: id, IdentityStatus: parsed.IdentityStatus, Title: parsed.Title, Aliases: parsed.Aliases,
			Kind: kind, RedirectTo: firstNonEmpty(meta["redirect_to"], meta["redirect"]),
			Namespace: namespace, QualifiedNS: qualifiedNS, NamespaceAliases: uniqueNamespaces(nsValues...),
			FullTitle: QualifiedTitle(qualifiedNS, parsed.Title), Repository: repo.Name, RepositoryID: repo.ID,
			RepositoryPath: file.RepositoryPath, Partition: repo.Partition, File: file.File,
			Blocks: parsed.Blocks, WikiLinks: parsed.WikiLinks,
		},
		Key: id, PageKey: firstNonEmpty(repo.UID, repo.ID) + ":" + file.RepositoryPath,
		QualifiedTitle: QualifiedTitle(namespace, parsed.Title), NamespaceSource: source, Tags: parsed.Tags,
		Private: repo.Partition == "private" || strings.ToLower(meta["private"]) == "true",
		Path:    workspacePath, RepositoryUID: firstNonEmpty(repo.UID, repo.ID),
		MtimeMs: file.MtimeMs, CreatedMs: createdTime(meta["date"]),
		Dependencies: dependencyRefs(cached.deps, exists), SearchText: approved,
		DuplicateBlockIDs: parsed.DuplicateBlockIDs,
		Link:              workspacePath,
		Size:              file.Size,
	}
	return note, true
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

// jsExtname is Node's path.extname: a name whose only dot leads it
// (".gitignore") has no extension.
func jsExtname(file string) string {
	base := filepath.Base(file)
	dot := strings.LastIndex(base, ".")
	if dot <= 0 {
		return ""
	}
	return base[dot:]
}

// parallel runs WORK for 0..n-1 on a few goroutines.
func parallel(n int, work func(int)) {
	workers := runtime.NumCPU()
	if workers > 16 {
		workers = 16
	}
	if workers < 1 {
		workers = 1
	}
	var next int64 = -1
	var wait sync.WaitGroup
	for w := 0; w < workers; w++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for {
				index := int(atomic.AddInt64(&next, 1))
				if index >= n {
					return
				}
				work(index)
			}
		}()
	}
	wait.Wait()
}
