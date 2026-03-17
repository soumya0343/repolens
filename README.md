# RepoLens

RepoLens is a comprehensive repository analysis platform that provides deep insights into software project health, architecture, and development patterns. It combines multiple analysis engines to evaluate code quality, architectural decisions, and team productivity metrics.

## Features

### Phase 1: Foundation ✅
- **Repository Connection**: GitHub OAuth integration for secure repository access (currently using mock auth - see setup for real OAuth)
- **Database Layer**: PostgreSQL with TimescaleDB for time-series data, Neo4j for graph analysis
- **Basic API**: RESTful endpoints for repository management and analysis
- **Dashboard**: Modern React/TypeScript frontend with real-time updates

### Phase 2: Core Analysis Engines
- **CoChangeOracle**: File coupling analysis using FP-Growth algorithm with decay-based temporal weighting
- **ChurnBusFactorAnalyzer**: Developer productivity analysis using Herfindahl-Hirschman Index (HHI)
- **ArchSentinel**: Architecture compliance checking (placeholder for Phase 3)
- **TestPulse**: CI/CD failure pattern analysis (placeholder for Phase 3)

### Phase 3: Advanced Features (Planned)
- **ArchSentinel**: Tree-sitter based AST analysis and OPA policy evaluation
- **TestPulse**: Log parsing and failure clustering using Drain3
- **Real-time Monitoring**: WebSocket-based live updates
- **Advanced Visualizations**: Interactive dependency graphs and risk heatmaps

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
│ (TimescaleDB)   │    │   (Queue)       │    │   (Graphs)      │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## Quick Start

### Prerequisites
- Docker and Docker Compose
- GitHub OAuth App (for authentication)

### Setup

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd repolens
   ```

2. **Environment Configuration**
   ```bash
   # Copy and configure environment files
   cp .env.example .env
   # Edit .env with your GitHub OAuth credentials
   ```

3. **Set up GitHub OAuth (Required for real authentication)**
   - Go to [GitHub Developer Settings](https://github.com/settings/developers)
   - Click "New OAuth App"
   - Fill in:
     - **Application name**: RepoLens
     - **Homepage URL**: `http://localhost:5173`
     - **Authorization callback URL**: `http://localhost:5173/auth/callback`
   - Copy the Client ID and Client Secret to your `.env` file:
     ```bash
     GITHUB_CLIENT_ID=your_actual_client_id
     GITHUB_CLIENT_SECRET=your_actual_client_secret
     ```
   - **Note**: Without real GitHub OAuth credentials, the system will use mock authentication for development

4. **Start the services**
   ```bash
   docker-compose up -d
   ```

5. **Access the application**
   - Frontend: http://localhost:5173
   - API: http://localhost:8000
   - API Docs: http://localhost:8000/docs

### GitHub OAuth Setup

1. Go to GitHub Settings → Developer settings → OAuth Apps
2. Create a new OAuth App with:
   - Homepage URL: `http://localhost:5173`
   - Authorization callback URL: `http://localhost:5173/auth/callback`
3. Copy Client ID and Client Secret to your `.env` file

## Development

### Local Development Setup

1. **Backend Services**
   ```bash
   # Start databases
   docker-compose up -d postgres redis neo4j

   # Install dependencies and run API
   cd api
   pip install -r requirements.txt
   uvicorn main:app --reload --host 0.0.0.0 --port 8000
   ```

2. **Frontend**
   ```bash
   cd frontend
   npm install
   npm run dev
   ```

3. **Workers**
   ```bash
   # In separate terminals
   cd worker && arq worker.WorkerSettings
   cd arch-worker && arq worker.WorkerSettings
   cd ci-worker && arq worker.WorkerSettings
   ```

### Testing

```bash
# Run API tests
cd api && python -m pytest

# Run frontend tests
cd frontend && npm test

# Manual testing with sample data
curl -X POST http://localhost:8000/repos/connect \
  -H "Content-Type: application/json" \
  -d '{"github_token": "your-token", "owner": "owner", "name": "repo"}'
```

## API Endpoints

### Repository Management
- `POST /repos/connect` - Connect a GitHub repository
- `GET /repos/{repo_id}` - Get repository details
- `GET /repos/{repo_id}/analysis` - Get analysis results

### Analysis Endpoints
- `GET /repos/{repo_id}/coupling` - File coupling analysis
- `GET /repos/{repo_id}/churn` - Churn analysis
- `GET /repos/{repo_id}/architecture` - Architecture analysis

### Real-time Updates
- `WebSocket /ws/{repo_id}` - Real-time analysis updates

## Analysis Engines

### CoChangeOracle
Analyzes file coupling using FP-Growth algorithm with temporal decay:
- **Input**: Git commit history
- **Output**: File coupling scores with confidence metrics
- **Algorithm**: FP-Growth with DERAR decay function

### ChurnBusFactorAnalyzer
Evaluates developer productivity and bus factor risk:
- **Input**: Author contribution data
- **Output**: HHI concentration index and risk scores
- **Algorithm**: Herfindahl-Hirschman Index calculation

## Configuration

### Environment Variables

```bash
# Database
DATABASE_URL=postgresql://user:password@localhost/repolens
NEO4J_URI=bolt://localhost:7687
REDIS_URL=redis://localhost:6379

# GitHub OAuth
GITHUB_CLIENT_ID=your-client-id
GITHUB_CLIENT_SECRET=your-client-secret

# Application
SECRET_KEY=your-secret-key
FRONTEND_URL=http://localhost:5173
```

### Docker Services

- **api**: FastAPI backend (port 8000)
- **frontend**: React/TypeScript UI (port 5173)
- **worker**: Main analysis worker
- **arch-worker**: Architecture analysis worker
- **ci-worker**: CI/CD analysis worker
- **ingestor**: Data ingestion service (port 8001)
- **postgres**: Primary database
- **redis**: Queue and caching
- **neo4j**: Graph database

## Troubleshooting

### Common Issues

1. **Mock Authentication Instead of Real GitHub OAuth**
   - **Symptom**: "Sign in with GitHub" redirects to callback with mock data
   - **Cause**: GitHub OAuth credentials not configured in `.env`
   - **Solution**: Follow the GitHub OAuth setup steps above and replace placeholder values in `.env`

2. **Worker Connection Errors**
   - Ensure Redis is running: `docker-compose logs redis`
   - Check worker logs: `docker-compose logs worker`

3. **Database Connection Issues**
   - Verify PostgreSQL is healthy: `docker-compose exec postgres pg_isready`
   - Check connection string in environment variables

3. **GitHub API Rate Limits**
   - Monitor API usage in GitHub settings
   - Implement token rotation for high-volume analysis

4. **Memory Issues**
   - Increase Docker memory limits
   - Monitor Neo4j heap usage

### Logs and Debugging

```bash
# View all service logs
docker-compose logs

# View specific service logs
docker-compose logs api

# Follow logs in real-time
docker-compose logs -f worker

# Check service health
docker-compose ps
```

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes and add tests
4. Run the test suite: `docker-compose exec api python -m pytest`
5. Submit a pull request

### Development Guidelines

- Follow PEP 8 for Python code
- Use TypeScript strict mode for frontend
- Add tests for new features
- Update documentation for API changes
- Use conventional commits

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Roadmap

### Phase 3: Advanced Analysis
- [ ] Tree-sitter AST analysis
- [ ] OPA policy evaluation
- [ ] Drain3 log parsing
- [ ] Real-time WebSocket updates
- [ ] Advanced visualizations

### Phase 4: Enterprise Features
- [ ] Multi-repository analysis
- [ ] Team productivity dashboards
- [ ] Integration with CI/CD pipelines
- [ ] Custom rule engines
- [ ] Export and reporting

## Support

For questions and support:
- Open an issue on GitHub
- Check the documentation
- Review the troubleshooting guide

## Acknowledgments

- FP-Growth algorithm implementation inspired by MLxtend
- HHI calculations based on economic concentration metrics
- Architecture analysis concepts from software engineering research