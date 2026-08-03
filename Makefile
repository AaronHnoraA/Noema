PORT ?= 5179
HOST ?= 127.0.0.1
ROOT ?= ../roam
NOEMA_ROOT ?= $(HOME)/Documents/Noema
NODE_VERSION := $(shell tr -d '\r\n' < .nvmrc)
NPM_VERSION := 11.17.0
NVM_SH ?= $(HOME)/.nvm/nvm.sh
APP_NAME := Noema
APP_DEST := /Applications/$(APP_NAME).app
APP_BUNDLE := $(firstword $(wildcard src-tauri/target/*/release/bundle/macos/$(APP_NAME).app src-tauri/target/release/bundle/macos/$(APP_NAME).app))
ICON_SVG := public/Noema.svg
ICON_ICNS := src-tauri/icons/icon.icns

.DEFAULT_GOAL := build

.PHONY: all bootstrap build build-web check-env clean dev help icon init-data \
	install install-app jupyter-bootstrap nvm-install run server-build \
	server-config-init server-deploy server-start setup test

all: build

check-env:
	@command -v node >/dev/null || (echo "Node $(NODE_VERSION) is required; run 'make nvm-install'" && exit 1)
	@test "$$(node --version)" = "v$(NODE_VERSION)" || \
		(echo "Expected Node v$(NODE_VERSION), got $$(node --version); run 'nvm install && nvm use'" && exit 1)
	@command -v npm >/dev/null || (echo "npm $(NPM_VERSION) is required" && exit 1)
	@test "$$(npm --version)" = "$(NPM_VERSION)" || \
		(echo "Expected npm $(NPM_VERSION), got $$(npm --version); run 'npm install -g npm@$(NPM_VERSION)'" && exit 1)

nvm-install:
	@test -s "$(NVM_SH)" || \
		(echo "nvm not found at $(NVM_SH); install nvm first: https://github.com/nvm-sh/nvm" && exit 1)
	bash -lc 'source "$(NVM_SH)" && nvm install "$(NODE_VERSION)" && nvm use "$(NODE_VERSION)" && npm install -g "npm@$(NPM_VERSION)"'

bootstrap: check-env
	npm ci

init-data:
	mkdir -p "$(NOEMA_ROOT)"

setup: bootstrap init-data

build: check-env icon
	npm run build:desktop

install: install-app

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

dev: check-env init-data
	npm run start:vite

icon: $(ICON_ICNS)

$(ICON_ICNS): $(ICON_SVG)
	node_modules/.bin/tauri icon "$(ICON_SVG)" --output src-tauri/icons

install-app:
	@test -n "$(APP_BUNDLE)" || (echo "Noema.app was not generated under release" && exit 1)
	node scripts/install-local-app.mjs "$(CURDIR)/$(APP_BUNDLE)" "$(APP_DEST)"

run: build
	open "$(CURDIR)/$(APP_BUNDLE)"

test: check-env
	npm test

clean:
	rm -rf build dist release src-tauri/target src-tauri/binaries src-tauri/gen/runtime

jupyter-bootstrap:
	npm run jupyter:bootstrap

help:
	@echo "Noema build targets"
	@echo "  make | make build  Build Noema.app under release/"
	@echo "  make setup         Install dependencies and create $(NOEMA_ROOT)"
	@echo "  make bootstrap     Reproducibly install dependencies with npm ci"
	@echo "  make nvm-install   Install/use pinned Node and npm through nvm"
	@echo "  make init-data     Create the Noema notes directory"
	@echo "  make install       Link /Applications/Noema.app to the existing local build"
	@echo "  make run           Build and launch the local app bundle"
	@echo "  make build-web     Build only the web assets"
	@echo "  make dev           Run the Vite development server"
	@echo "  make server-config-init  Create ignored Server mode config files"
	@echo "  make server-build  Build the rsync-ready Server mode release"
	@echo "  make server-start  Run Server mode from server-config/runtime.json"
	@echo "  make server-deploy Build, rsync, and restart the configured user service"
	@echo "  make test          Run the test suite"
	@echo "  make clean         Remove generated build, dist, and release output"
