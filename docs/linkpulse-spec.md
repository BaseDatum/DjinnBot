# LinkPulse — URL Bookmarking & Health-Check API

## Overview

LinkPulse is a small REST API that lets users save URL bookmarks with metadata and automatically monitors whether those URLs are alive or dead. Think of it as a personal link-rot detector.

This is a Python + Flask project using SQLAlchemy for models, Alembic for migrations, Pydantic for validation, and pytest for testing. No frontend — API only. Keep it simple, keep it small.

## Tech Stack

- **Python 3.11+**
- **Flask** (latest) — web framework
- **SQLAlchemy 2.x** — ORM with declarative models (use the modern `Mapped[]` / `mapped_column()` syntax)
- **Alembic** — database migrations (auto-generate from model changes)
- **Pydantic v2** — request/response validation and serialization
- **SQLite** — database (via SQLAlchemy; easy to swap to Postgres later)
- **pytest** — testing
- **httpx** — HTTP client for health checks (async-capable, timeout-friendly)
- **No external task queue** — health checks run via a CLI command (`python -m linkpulse.checker`), not a background thread

## Data Model (SQLAlchemy)

### `Bookmark` model

| Column | Type | Notes |
|--------|------|-------|
| id | Integer, primary key, autoincrement | |
| url | String, not null, unique | The bookmarked URL |
| title | String, not null | Human-readable title |
| description | String, default '' | Optional description |
| tags | String, default '' | Comma-separated tags (e.g. "python,flask,api") |
| created_at | DateTime, not null | UTC, auto-set on create |
| updated_at | DateTime, not null | UTC, auto-set on create and update |

Relationship: `health_checks` → one-to-many with `HealthCheck`, cascade delete.

### `HealthCheck` model

| Column | Type | Notes |
|--------|------|-------|
| id | Integer, primary key, autoincrement | |
| bookmark_id | Integer, ForeignKey('bookmarks.id'), not null | |
| status_code | Integer, nullable | HTTP status code (null if request failed) |
| is_alive | Boolean, not null | true if 2xx, false otherwise |
| response_time_ms | Integer, nullable | Response time in milliseconds |
| error | String, nullable | Error message if request failed |
| checked_at | DateTime, not null | UTC, auto-set on create |

Relationship: `bookmark` → many-to-one back to `Bookmark`.

## Pydantic Schemas

Define these in `linkpulse/schemas.py`:

### Request Schemas

- **BookmarkCreate**: `url` (HttpUrl, required), `title` (str, min_length=1, max_length=500), `description` (str, default='', max_length=2000), `tags` (str, default='', max_length=500)
- **BookmarkUpdate**: all fields optional (partial update) — `title` (str | None), `description` (str | None), `tags` (str | None). At least one field must be provided.

### Response Schemas

- **BookmarkResponse**: all model fields + `last_check` (HealthCheckResponse | None)
- **HealthCheckResponse**: all model fields from HealthCheck
- **BookmarkDetailResponse**: all model fields + `checks` (list[HealthCheckResponse])
- **PaginatedResponse**: `items` (list[BookmarkResponse]), `total` (int), `page` (int), `per_page` (int), `pages` (int)
- **ErrorResponse**: `error` (str)

Use Pydantic's `model_validate` / `from_attributes = True` to serialize SQLAlchemy models directly.

## API Endpoints

### Bookmarks CRUD

**POST /api/bookmarks**
- Body: BookmarkCreate schema
- Validates via Pydantic: `url` is a valid HTTP/HTTPS URL, `title` is non-empty
- Returns: 201 with BookmarkResponse
- Error: 400 if Pydantic validation fails (return all field errors), 409 if URL already exists

**GET /api/bookmarks**
- Query params: `?tag=python` (filter by tag), `?alive=true|false` (filter by last health status), `?page=1&per_page=20` (pagination)
- Returns: 200 with PaginatedResponse
- Each bookmark includes `last_check` (latest health check result or null)

**GET /api/bookmarks/{id}**
- Returns: 200 with BookmarkDetailResponse (bookmark + full health check history)
- Error: 404 if not found

**PUT /api/bookmarks/{id}**
- Body: BookmarkUpdate schema (partial update)
- Returns: 200 with BookmarkResponse
- Error: 404 if not found, 400 if validation fails

**DELETE /api/bookmarks/{id}**
- Returns: 204 (cascade deletes associated health checks via SQLAlchemy relationship)
- Error: 404 if not found

### Health Checks

**POST /api/bookmarks/{id}/check**
- Triggers an immediate health check for a single bookmark
- Returns: 200 with HealthCheckResponse
- Error: 404 if bookmark not found

**GET /api/bookmarks/{id}/checks**
- Returns: 200 with list of HealthCheckResponse (most recent first, limit 50)

**GET /api/health**
- App health endpoint
- Returns: 200 `{"status": "ok", "bookmark_count": N}`

### Bulk Checker CLI

`python -m linkpulse.checker` — checks ALL bookmarks, writes results to `health_checks` table. Should:
- Use httpx with a 10-second timeout per URL
- Handle connection errors, timeouts, SSL errors gracefully (record error, mark as not alive)
- Print a summary to stdout: `Checked 42 bookmarks: 38 alive, 4 dead`

## Alembic Setup

- Initialize Alembic in the project root with `alembic init alembic`
- Configure `alembic/env.py` to import the SQLAlchemy `Base` metadata and use the app's database URL
- The initial migration should create both `bookmarks` and `health_checks` tables
- Use `alembic revision --autogenerate -m "description"` to create migrations
- Use `alembic upgrade head` to apply
- The test fixtures should run migrations against the test database (or use `Base.metadata.create_all()` for speed)

## Project Structure

```
linkpulse/
  pyproject.toml
  alembic.ini
  README.md
  alembic/
    env.py
    versions/
      001_initial_tables.py   # Initial migration: bookmarks + health_checks
  linkpulse/
    __init__.py
    app.py                    # Flask app factory, register blueprints, init DB
    db.py                     # SQLAlchemy engine, session factory, Base
    models.py                 # Bookmark and HealthCheck SQLAlchemy models
    schemas.py                # Pydantic request/response schemas
    routes/
      __init__.py
      bookmarks.py            # Bookmark CRUD blueprint
      health.py               # Health check endpoints + app health blueprint
    checker.py                # CLI bulk health checker (__main__ entry)
  tests/
    __init__.py
    conftest.py               # Fixtures: test client, test database, session
    test_bookmarks.py         # CRUD endpoint tests
    test_health.py            # Health check endpoint tests
    test_checker.py           # Bulk checker tests (mock HTTP)
    test_schemas.py           # Pydantic schema validation tests
```

## Requirements

### Functional
1. Users can create, read, update, delete bookmarks
2. Users can filter bookmarks by tag and by alive/dead status
3. Users can trigger health checks for individual bookmarks
4. A CLI command checks all bookmarks and records results
5. Health check history is preserved (not overwritten)
6. Pagination on list endpoints (default 20 per page)

### Non-Functional
1. All endpoints return JSON with consistent error format via Pydantic's ErrorResponse
2. Input validation on all write endpoints via Pydantic schemas — return structured field-level errors on 400
3. URL validation: Pydantic HttpUrl type enforces valid http:// or https:// URL
4. Duplicate URLs rejected with 409 Conflict (catch SQLAlchemy IntegrityError)
5. Health checker has 10-second timeout per URL
6. Tests cover happy path, validation errors, edge cases, and 404s
7. Test coverage should be comprehensive — test the bulk checker with mocked HTTP responses
8. README documents all endpoints with example curl commands
9. Alembic migrations are reversible (include downgrade)

## What This Project Is NOT

- No authentication (all endpoints are public)
- No frontend (API only)
- No Docker (just run with `flask run` or `python -m linkpulse.app`)
- No async Flask (use standard sync Flask; only the checker uses httpx)
- No background scheduler (checker is a manual CLI command)
- No rate limiting
- No WebSocket or SSE

## Quality Bar

- Every endpoint has at least 2 tests (happy path + error case)
- The bulk checker has tests with mocked HTTP responses
- Pydantic validation is thorough (empty strings, missing fields, invalid URLs, very long strings)
- Error responses are consistent JSON via Pydantic, never stack traces
- SQLAlchemy models use modern `Mapped[]` syntax
- Alembic migrations exist and are reversible
- Code is clean, well-organized, with docstrings on public functions
