# CLAUDE.md

> Think carefully and implement the most concise solution that changes as little code as possible.

## Project: Nexus - Distributed Task Orchestration Platform

A complex, production-grade distributed system for orchestrating computational tasks across heterogeneous worker nodes. Think "Kubernetes meets Celery meets Temporal" - designed for high-throughput, fault-tolerant task execution with real-time observability.

### Core Components

1. **Nexus API** - RESTful + GraphQL API gateway
2. **Nexus Scheduler** - Intelligent task distribution with DAG support
3. **Nexus Workers** - Polyglot worker runtime (Python, Node, Go, Rust)
4. **Nexus Queue** - Distributed message queue with persistence
5. **Nexus Store** - Time-series metrics + task state storage
6. **Nexus UI** - Real-time dashboard with live task visualization
7. **Nexus CLI** - Developer tooling and management commands
8. **Nexus SDK** - Client libraries for task submission

### Technical Stack

- **Backend**: Node.js (TypeScript) + Go for performance-critical paths
- **Frontend**: React + D3.js for visualization
- **Database**: PostgreSQL (state) + Redis (cache) + ClickHouse (metrics)
- **Queue**: Custom implementation over Redis Streams
- **Protocol**: gRPC for inter-service, WebSocket for real-time

### Key Features

- DAG-based task dependencies
- Priority queues with fair scheduling
- Automatic retry with exponential backoff
- Task result caching and deduplication
- Real-time progress streaming
- Multi-tenancy with resource quotas
- Distributed tracing integration

## Testing

- `npm test` - Unit tests
- `npm run test:integration` - Integration tests
- `npm run test:e2e` - End-to-end tests

## Git

Before pushing, ensure git is configured to use GitHub CLI credentials:
```bash
gh auth setup-git
```

Then push normally:
```bash
git push -u origin master
```

## Code Style

Follow existing patterns in the codebase. Use TypeScript strict mode.
