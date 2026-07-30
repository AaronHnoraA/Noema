PORT ?= 5179
HOST ?= 127.0.0.1
ROOT ?= ../roam
NOEMA_ROOT ?= $(HOME)/Documents/Noema
NODE_VERSION := $(shell tr -d '\r\n' < .nvmrc)
NPM_VERSION := 11.17.0
NVM_SH ?= $(HOME)/.nvm/nvm.sh
APP_NAME := Noema
APP_DEST := /Applications/$(APP_NAME).app
APP_BUNDLE := $(firstword $(wildcard release/mac*/$(APP_NAME).app release/mac/$(APP_NAME).app))
ICON_SVG := public/Noema.svg
ICON_PNG := build/Noema.png

.DEFAULT_GOAL := build

.PHONY: all bootstrap build build-web check-env clean dev help icon init-data \
	install install-app jupyter-bootstrap nvm-install run setup test

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

install: build install-app

build-web: check-env
	npm run build:aaronnote

dev: check-env init-data
	npm run start:vite

icon:
	mkdir -p build
	rsvg-convert -w 1024 -h 1024 "$(ICON_SVG)" -o "$(ICON_PNG)"

install-app:
	@test -n "$(APP_BUNDLE)" || (echo "Noema.app was not generated under release" && exit 1)
	@if [ -e "$(APP_DEST)" ]; then \
		backup_dir=$$(mktemp -d /private/tmp/noema-install.XXXXXX); \
		mv "$(APP_DEST)" "$$backup_dir/$(APP_NAME).app"; \
		echo "Previous app preserved at $$backup_dir/$(APP_NAME).app"; \
	fi
	cp -R "$(CURDIR)/$(APP_BUNDLE)" "$(APP_DEST)"
	@echo "Copied $(CURDIR)/$(APP_BUNDLE) -> $(APP_DEST)"

run: build
	open "$(CURDIR)/$(APP_BUNDLE)"

test: check-env
	npm test

clean:
	rm -rf build dist release

jupyter-bootstrap:
	npm run jupyter:bootstrap

help:
	@echo "Noema build targets"
	@echo "  make | make build  Build Noema.app under release/"
	@echo "  make setup         Install dependencies and create $(NOEMA_ROOT)"
	@echo "  make bootstrap     Reproducibly install dependencies with npm ci"
	@echo "  make nvm-install   Install/use pinned Node and npm through nvm"
	@echo "  make init-data     Create the Noema notes directory"
	@echo "  make install       Build and install /Applications/Noema.app"
	@echo "  make run           Build and launch the local app bundle"
	@echo "  make build-web     Build only the web assets"
	@echo "  make dev           Run the Vite development server"
	@echo "  make test          Run the test suite"
	@echo "  make clean         Remove generated build, dist, and release output"
