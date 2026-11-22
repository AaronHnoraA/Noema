package wikiindex

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"

	"strconv"
	"strings"
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
				Partition:          partition, Path: path})
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

func dependencyRefs(content, noteFile string, repository IndexRepository) []Dependency {
	refs := []Dependency{}
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
			refs = append(refs, Dependency{Kind: kind, Raw: value, Status: "outside-repository", Path: ""})
			return
		}
		status := "missing"
		if _, err := os.Stat(file); err == nil {
			status = "resolved"
		}
		rel, _ := filepath.Rel(repository.Path, file)
		refs = append(refs, Dependency{Kind: kind, Raw: value, Status: status, Path: filepath.ToSlash(rel)})
	}
	for _, m := range dependencyLinkRE.FindAllStringSubmatch(content, -1) {
		add(m[1], "asset")
	}
	for _, m := range includeRE.FindAllStringSubmatch(content, -1) {
		add(m[1], "include")
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
	root, err := filepath.Abs(root)
	if err != nil {
		return Index{}, err
	}
	repositories, diagnostics := discover(root)
	idx := Index{Repositories: repositories, Files: []IndexFile{}, Notes: []IndexNote{}}
	for _, repo := range repositories {
		statuses := gitStatuses(repo.Path)
		for _, file := range walkFiles(repo.Path) {
			info, err := os.Stat(file)
			if err != nil {
				continue
			}
			rel, _ := filepath.Rel(repo.Path, file)
			rel = filepath.ToSlash(rel)
			ext := strings.ToLower(jsExtname(file))
			kind := "file"
			if noteExtensions[ext] {
				kind = "note"
			}
			status := statuses[rel]
			if status == "" {
				status = "clean"
			}
			entry := IndexFile{RepositoryID: repo.ID, RepositoryUID: repo.UID, RepositoryPath: rel, File: file,
				Kind: kind, Ext: strings.TrimPrefix(ext, "."), Size: float64(info.Size()), MtimeMs: mtimeMs(info), GitStatus: status}
			idx.Files = append(idx.Files, entry)
			if kind != "note" {
				continue
			}
			content, err := os.ReadFile(file)
			if err != nil {
				continue
			}
			idx.Notes = append(idx.Notes, scanNote(root, repo, entry, string(content)))
		}
	}
	pages := make([]Page, len(idx.Notes))
	for index, note := range idx.Notes {
		pages[index] = note.Page
	}
	relations := Resolve(pages)
	for _, note := range idx.Notes {
		for _, id := range note.duplicateBlockIDs {
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

func scanNote(root string, repo IndexRepository, file IndexFile, content string) IndexNote {
	parsed, approved, meta := parseNote(content, file.File)
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
		Dependencies: dependencyRefs(approved, file.File, repo), SearchText: approved,
		duplicateBlockIDs: parsed.DuplicateBlockIDs,
	}
	return note
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
