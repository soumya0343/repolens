# RepoLens

GitHub-native SDLC intelligence platform. Transforms raw repository data into actionable developer insights — coupling analysis, architecture violations, bus factor, CI flakiness, team collaboration, and DORA metrics — surfaced via a React dashboard and a GitHub bot that comments on PRs.

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Frontend      │    │      API        │    │   Workers       │
│   (React/TS)    │◄──►│   (FastAPI)     │◄──►│   (ARQ/Redis)   │
│                 │    │                 │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   PostgreSQL    │    │     Redis       │    │     Neo4j       │
│ (TimescaleDB)   │    │  (Queue+Cache)  │    │   (ChronosGraph)│
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

**Services:** `api` · `ingestor` · `worker` · `arch-worker` · `ci-worker` · `classifier-worker` · `bot` · `frontend`

## Analysis Engines

| Engine | What it does |
|--------|-------------|
| **CoChangeOracle** | FP-Growth on commit history with DERAR decay → file coupling scores |
| **ArchSentinel** | Tree-sitter AST parsing + OPA policy evaluation → architectural violations |
| **ChurnBusFactorAnalyzer** | Herfindahl-Hirschman Index on contributor activity → bus factor risk |
| **ChronosGraph** | Multi-layer Neo4j graph (commits/reviews/authors) → reviewer suggestions, STMC scores |
| **TestPulse** | Drain3 log clustering + Bayesian flakiness model → flaky test detection |
| **ReleaseHealthTracker** | DORA metrics (deploy frequency, lead time, CFR, MTTR) from CI run data |
| **UnifiedRiskScorer** | Weighted aggregation of all six engines → single risk score per repo/PR |
| **LLMExplainer** | Gemini 1.5 Flash with Redis caching → root-cause explanations, arch policy generation |

## Quick Start

### Prerequisites

- Docker and Docker Compose
- GitHub OAuth App

### Setup

1. **Clone**
   ```bash
   git clone <repository-url>
   cd repolens
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   # Fill in required values (see Environment Variables below)
   ```

3. **Start services**
   ```bash
   docker-compose up -d
   ```

4. **Apply migrations**
   ```bash
   docker-compose exec api alembic upgrade head
   ```

5. **Access**
   - Frontend: http://localhost:5173
   - API: http://localhost:8000
   - API Docs: http://localhost:8000/docs

### GitHub OAuth App Setup

1. Go to GitHub Settings → Developer settings → OAuth Apps → New OAuth App
2. Set **Authorization callback URL** to: `http://localhost:5173/auth/callback`
3. Copy Client ID and Client Secret to `.env`

## Environment Variables

```bash
# Database
DATABASE_URL=postgresql+asyncpg://user:pass@postgres:5432/repolens
SYNC_DATABASE_URL=postgresql+psycopg2://user:pass@postgres:5432/repolens
NEO4J_AUTH=neo4j/your_password

# Redis
REDIS_HOST=redis

# GitHub OAuth (required for real auth)
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret

# Secrets — must be set to strong random values in production
JWT_SECRET=your_strong_jwt_secret
REPOLENS_API_KEY=your_strong_api_key   # shared between api and bot

# LLM (optional — falls back to structured placeholder if unset)
GEMINI_API_KEY=your_gemini_api_key

# Development only
DEV_MODE=false   # set to true to bypass GitHub OAuth with mock user
```

> **Production note:** API will refuse to start if `JWT_SECRET` or `REPOLENS_API_KEY` are left at their default weak values (and `DEV_MODE` is not `true`).

## Development Mode

Set `DEV_MODE=true` in `.env` to bypass GitHub OAuth. A mock user (`dev_user`) is created automatically with a mock token. This also suppresses the weak-secret startup check.

```bash
DEV_MODE=true
```

## Local Development (without Docker)

```bash
# Databases only via Docker
docker-compose up -d postgres redis neo4j

# API
cd api
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000

# Frontend
cd frontend
npm install
npm run dev

# Workers (separate terminals)
cd worker && arq worker.WorkerSettings
cd arch-worker && arq worker.WorkerSettings
cd ci-worker && arq worker.WorkerSettings
```

## API Reference

### Auth
| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth/github/` | Initiate OAuth flow |
| GET | `/auth/github/callback` | OAuth callback |

### Repositories
| Method | Path | Description |
|--------|------|-------------|
| GET | `/repos/github/available` | List user's GitHub repos |
| POST | `/repos/` | Connect a repo + trigger backfill |
| GET | `/repos/` | List connected repos |
| GET | `/repos/{id}` | Repo details + stats |
| PATCH | `/repos/{id}` | Update repo config (risk weights) |
| POST | `/repos/{id}/backfill` | Re-trigger backfill |

### Analysis
| Method | Path | Description |
|--------|------|-------------|
| GET | `/repos/{id}/files` | Files with real risk scores (churn + HHI + violations + coupling) |
| GET | `/repos/{id}/coupling` | CoChangeOracle coupling rules |
| GET | `/repos/{id}/violations` | ArchSentinel violations |
| GET | `/repos/{id}/risk` | Unified risk score breakdown |
| GET | `/repos/{id}/releases` | DORA metrics |
| GET | `/repos/{id}/tests/flaky` | Flaky test analysis |
| GET | `/repos/{id}/team/bus-factor` | Bus factor + ownership |
| GET | `/repos/{id}/team/graph` | Team social graph (nodes + edges) |
| GET | `/repos/{id}/score/history` | 30-day risk score trend |
| GET | `/repos/{id}/files/detail` | Per-file churn, ownership, coupling, violations |
| GET | `/repos/{id}/reviewers/suggest` | Reviewer suggestions from ChronosGraph |
| POST | `/repos/{id}/policy/generate` | LLM-generated arch policy |

### Pull Requests
| Method | Path | Description |
|--------|------|-------------|
| GET | `/repos/{id}/prs` | List PRs with predicted risk |
| GET | `/repos/{id}/prs/{pr_id}` | PR detail |
| POST | `/repos/{id}/prs/{pr_id}/explain` | LLM risk explanation |

### WebSocket
| Path | Description |
|------|-------------|
| `ws://host/ws/progress/{repo_id}` | Backfill progress stream |
| `ws://host/ws/repos/{repo_id}/live` | Live PR risk score stream |

### Chat
| Method | Path | Description |
|--------|------|-------------|
| POST | `/chat` | LLM assistant with 6 tool-use tools |

## GitHub Bot

The bot listens for `pull_request` webhooks and:
1. Creates a pending GitHub Check Run
2. Fetches risk analysis from the internal API
3. Posts a structured PR comment with score breakdown and recommended actions
4. Posts inline diff annotations for architectural violations
5. Updates the Check Run to pass/fail based on configurable threshold

**Required env vars for bot:**
```bash
GITHUB_APP_ID=
GITHUB_PRIVATE_KEY=        # PEM key, newlines as \n
GITHUB_WEBHOOK_SECRET=
REPOLENS_API_URL=http://api:8000
REPOLENS_API_KEY=          # must match api's REPOLENS_API_KEY
```

## File Risk Score Formula

Each file's risk score (0–100) is computed from four real signals:

| Signal | Max points | Source |
|--------|-----------|--------|
| Churn (change frequency) | 35 | `commit_files` table |
| Bus factor (per-file HHI) | 35 | ChurnBusFactorAnalyzer |
| Architectural violations | 30 | ArchSentinel / ArchAnalysis |
| Coupling bonus | 10 | CoChangeOracle |

## Troubleshooting

**API won't start (weak secret error)**
Set strong values for `JWT_SECRET` and `REPOLENS_API_KEY` in `.env`, or set `DEV_MODE=true` for local development.

**Mock auth instead of real GitHub**
Ensure `DEV_MODE=false` (default) and `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` are set in `.env`.

**Worker connection errors**
```bash
docker-compose logs worker
docker-compose logs redis
```

**Database issues**
```bash
docker-compose exec postgres pg_isready
docker-compose exec api alembic upgrade head
```

**GitHub API rate limits**
Use a GitHub App installation token (higher rate limits than OAuth tokens) or add token rotation.

**Local PostgreSQL port conflict**
```bash
brew services stop postgresql@16
```
Then restart: `docker-compose up -d postgres`
