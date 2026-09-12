VENV := .venv
PY   := $(VENV)/bin/python

.PHONY: install serve seed digest test lint format verify clean

install:
	uv venv --python 3.12
	uv pip install -e ".[dev]"

serve:
	$(VENV)/bin/fridge serve --reload

seed:
	$(VENV)/bin/fridge seed

digest:
	$(VENV)/bin/fridge digest

test:
	$(PY) -m pytest -q

lint:
	$(VENV)/bin/ruff check .

format:
	$(VENV)/bin/ruff format .

verify: lint test
	$(VENV)/bin/ruff format --check .

clean:
	rm -rf var/fridge.db var/fridge.db-wal var/fridge.db-shm var/frames/*.jpg var/clips/*.mp4
