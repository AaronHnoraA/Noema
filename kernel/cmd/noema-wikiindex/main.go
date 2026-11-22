// Command noema-wikiindex writes a wiki.db from a built index.
//
//	noema-wikiindex -index index.json -out new.db
//	noema-wikiindex -scan VAULT -out new.db
//	noema-wikiindex -refresh VAULT [-full]   (prints the refresh result and index as JSON)
//
// It never writes into an existing database (wikiindex.WriteDatabase refuses),
// so it is safe to run beside the real index while the kernel's builder is
// proved against Node's (docs/noema/design/wiki-workspace.md "Index ownership").
package main

import (
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	_ "github.com/mattn/go-sqlite3"

	"github.com/aaronhe/noema/kernel/noema/wikiindex"
)

func main() {
	indexFile := flag.String("index", "", "index JSON as Node's buildWikiIndex returns it, with searchText")
	scanRoot := flag.String("scan", "", "vault root to scan and parse instead of reading -index")
	refreshRoot := flag.String("refresh", "", "vault root whose .noema/wiki.db to refresh in place, printing the result as JSON")
	full := flag.Bool("full", false, "with -refresh, build in full")
	out := flag.String("out", "", "database file to create; must not exist")
	flag.Parse()
	if *refreshRoot != "" {
		result, err := wikiindex.Refresh(*refreshRoot, *full)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if (*indexFile == "") == (*scanRoot == "") || *out == "" {
		fmt.Fprintln(os.Stderr, "usage: noema-wikiindex (-index index.json | -scan VAULT) -out new.db")
		os.Exit(2)
	}
	if _, err := os.Stat(*out); err == nil {
		fmt.Fprintf(os.Stderr, "%s exists; refusing to replace it\n", *out)
		os.Exit(1)
	}
	var index wikiindex.Index
	started := time.Now()
	if *scanRoot != "" {
		scanned, err := wikiindex.Scan(*scanRoot)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		index = scanned
		fmt.Printf("scanned %d repositories in %s\n", len(index.Repositories), time.Since(started).Round(time.Millisecond))
	} else {
		raw, err := os.ReadFile(*indexFile)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if err := json.Unmarshal(raw, &index); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	db, err := sql.Open("sqlite3", *out)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer db.Close()
	if err := wikiindex.WriteDatabase(db, index, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("wrote %d pages, %d files to %s in %s\n", len(index.Notes), len(index.Files), *out, time.Since(started).Round(time.Millisecond))
}
