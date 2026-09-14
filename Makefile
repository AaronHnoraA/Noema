PORT ?= 5179
HOST ?= 127.0.0.1
ROOT ?= ../roam
NOEMA_ROOT ?= $(HOME)/Documents/Noema
NODE_VERSION := $(shell tr -d '\r\n' < .nvmrc)
NPM_VERSION := 11.17.0
NVM_SH ?= $(HOME)/.nvm/nvm.sh
KERNEL_DIR := kernel
KERNEL_BIN_NAME := noema-kernel
KERNEL_GOOS ?= $(shell go env GOOS 2>/dev/null)
KERNEL_GOARCH ?= $(shell go env GOARCH 2>/dev/null)
KERNEL_BUILD_DIR := build/kernel/$(KERNEL_GOOS)-$(KERNEL_GOARCH)
KERNEL_BIN := $(KERNEL_BUILD_DIR)/$(KERNEL_BIN_NAME)
KERNEL_BIN_LINK ?= $(HOME)/.local/bin/$(KERNEL_BIN_NAME)

.DEFAULT_GOAL := build

.PHONY: all bootstrap build build-web check-env check-go clean clean-all dev \
	disk-audit help \
	init-data install jupyter-bootstrap kernel-build kernel-install \
	nvm-install prune-legacy-garbage server-build \
	server-config-init server-deploy server-start setup test

all: build

check-env:
	@command -v node >/dev/null || (echo "Node $(NODE_VERSION) is required; run 'make nvm-install'" && exit 1)
	@test "$$(node --version)" = "v$(NODE_VERSION)" || \
		(echo "Expected Node v$(NODE_VERSION), got $$(node --version); run 'nvm install && nvm use'" && exit 1)
	@command -v npm >/dev/null || (echo "npm $(NPM_VERSION) is required" && exit 1)
	@test "$$(npm --version)" = "$(NPM_VERSION)" || \
		(echo "Expected npm $(NPM_VERSION), got $$(npm --version); run 'npm install -g npm@$(NPM_VERSION)'" && exit 1)

check-go:
	@command -v go >/dev/null || (echo "Go is required to build the kernel; see https://go.dev/dl/" && exit 1)

nvm-install:
	@test -s "$(NVM_SH)" || \
		(echo "nvm not found at $(NVM_SH); install nvm first: https://github.com/nvm-sh/nvm" && exit 1)
	bash -lc 'source "$(NVM_SH)" && nvm install "$(NODE_VERSION)" && nvm use "$(NODE_VERSION)" && npm install -g "npm@$(NPM_VERSION)"'

bootstrap: check-env
	npm ci

init-data:
	mkdir -p "$(NOEMA_ROOT)"

setup: bootstrap init-data

build: check-env check-go prune-legacy-garbage build-web kernel-build

# Noema has no application bundle. The build produces the headless engine and
# the CM6 renderer hosted by Emacs xwidget/Appine.
install: build kernel-install

build-web: check-env
	npm run build:aaronnote

server-config-init: check-env
	node scripts/init-server-config.mjs

server-build: check-env build-web
	node scripts/build-server-release.mjs

server-start: check-env
	@test -f "$(CURDIR)/server-config/runtime.json" || \
		(echo "Missing server-config/runtime.json; run 'make server-config-init'" && exit 1)
	AARONNOTE_HOST_MODE=server NOEMA_SERVER_CONFIG="$(CURDIR)/server-config/runtime.json" node web-host.mjs

server-deploy: server-build
	node scripts/deploy-server.mjs

kernel-build: check-go
	@mkdir -p "$(KERNEL_BUILD_DIR)"
	cd "$(KERNEL_DIR)" && CGO_ENABLED=1 GOOS=$(KERNEL_GOOS) GOARCH=$(KERNEL_GOARCH) \
		go build -tags fts5 -ldflags "-s -w" -o "$(CURDIR)/$(KERNEL_BIN)" .
	rm -f "$(KERNEL_BUILD_DIR)/app"
	ln -sfn "$(CURDIR)/kernel-resources" "$(KERNEL_BUILD_DIR)/kernel-resources"

kernel-install: kernel-build
	mkdir -p "$(dir $(KERNEL_BIN_LINK))"
	ln -sfn "$(CURDIR)/$(KERNEL_BIN)" "$(KERNEL_BIN_LINK)"
	@echo "Linked $(KERNEL_BIN_LINK) -> $(KERNEL_BIN) (binary and kernel resources stay linked, nothing copied)"

dev: check-env init-data
	npm run start:vite

test: check-env
	npm test

prune-legacy-garbage:
	rm -rf "$(CURDIR)/release"

clean: prune-legacy-garbage
	rm -rf "$(CURDIR)/build/kernel" "$(CURDIR)/dist"
	@echo "Removed generated kernel and renderer output; project state was preserved."

clean-all: clean
	rm -rf "$(CURDIR)/build"
	@echo "Removed all generated Noema output; project-local .agent/.noema state was preserved."

disk-audit:
	@for candidate in release build/kernel dist "$(HOME)/.local/state/noema"; do \
		if [ -e "$$candidate" ]; then du -sh "$$candidate"; fi; \
	done
	@if [ -d node_modules ]; then du -sh node_modules; fi

jupyter-bootstrap:
	npm run jupyter:bootstrap

help:
	@echo "Noema build targets"
	@echo "  make | make build  Build the Emacs-hosted CM6 renderer and headless Go engine"
	@echo "  make setup         Install dependencies and create $(NOEMA_ROOT)"
	@echo "  make bootstrap     Reproducibly install dependencies with npm ci"
	@echo "  make nvm-install   Install/use pinned Node and npm through nvm"
	@echo "  make init-data     Create the Noema notes directory"
	@echo "  make install       Build and link the headless kernel onto PATH"
	@echo "  make build-web     Build the renderer consumed by Emacs xwidget/Appine"
	@echo "  make dev           Run the Vite development server"
	@echo "  make server-config-init  Create ignored Server mode config files"
	@echo "  make server-build  Build the rsync-ready Server mode release"
	@echo "  make server-start  Run Server mode from server-config/runtime.json"
	@echo "  make server-deploy Build, rsync, and restart the configured user service"
	@echo "  make kernel-build  Build the Go kernel binary under build/kernel/ (linked to kernel-resources/)"
	@echo "  make kernel-install  Link the kernel binary onto PATH ($(KERNEL_BIN_LINK))"
	@echo "  make test          Run the test suite"
	@echo "  make disk-audit    Report disk use for Noema's generated outputs"
	@echo "  make clean         Remove generated kernel and renderer output"
	@echo "  make clean-all     Remove all generated output; preserve project state"
