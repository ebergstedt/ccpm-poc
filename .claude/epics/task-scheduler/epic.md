---
name: task-scheduler
status: backlog
created: 2026-01-17T08:58:46Z
progress: 0%
prd: .claude/prds/task-scheduler.md
github: https://github.com/ebergstedt/ccpm-poc/issues/1
---

# Epic: task-scheduler

## Overview

Replace the existing round-robin scheduler with a predictive task scheduler that optimizes worker assignment using heuristic-based predictions. The scheduler uses exponential moving averages for task duration prediction and real-time worker capacity metrics to make intelligent placement decisions in < 10ms.

**Key Simplification**: This is Phase 1 (MVP) only - heuristics-based, no ML, no advanced features. The architecture supports future extensibility but we build only what's needed now.

## Architecture Decisions

### 1. Scheduler as Standalone Service
- **Decision**: Implement scheduler as a separate TypeScript service
- **Rationale**: Allows independent scaling and deployment; isolates prediction logic from queue infrastructure
- **Alternative rejected**: Embedded in queue service (harder to test and evolve)

### 2. In-Memory Prediction with Redis Backup
- **Decision**: Keep prediction state in-memory with periodic Redis snapshots
- **Rationale**: Meets < 10ms latency requirement; no external I/O during scheduling
- **Trade-off**: Cold start requires bootstrapping from Redis or sensible defaults

### 3. Pluggable Predictor Interface
- **Decision**: Define `Predictor` interface with `HeuristicPredictor` as initial implementation
- **Rationale**: Enables future ML models without architectural changes
- **Implementation**: Strategy pattern with runtime selection

### 4. Event-Driven Metrics Collection
- **Decision**: Workers emit metrics via existing gRPC streams; scheduler subscribes
- **Rationale**: Leverages existing Nexus Workers gRPC infrastructure; no new protocols

### 5. Fallback-First Reliability
- **Decision**: Any prediction failure immediately falls back to round-robin
- **Rationale**: Availability over accuracy for MVP; builds operator confidence

## Technical Approach

### Core Components

```
┌─────────────────────────────────────────────────────────────┐
│                    Predictive Scheduler                      │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Predictor   │  │    Scorer    │  │  Worker Registry │  │
│  │  (Heuristic) │  │ (Multi-obj)  │  │  (Capacity Map)  │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│           │                │                   │            │
│           └────────────────┼───────────────────┘            │
│                            ▼                                │
│                   ┌──────────────┐                          │
│                   │  Dispatcher  │                          │
│                   └──────────────┘                          │
└─────────────────────────────────────────────────────────────┘
         │                   │                    │
         ▼                   ▼                    ▼
   ┌──────────┐      ┌─────────────┐      ┌─────────────┐
   │  Redis   │      │  ClickHouse │      │   Workers   │
   │ (Queue)  │      │  (Metrics)  │      │   (gRPC)    │
   └──────────┘      └─────────────┘      └─────────────┘
```

### Data Models

**Task Prediction Record**
```typescript
interface TaskPrediction {
  taskType: string;
  estimatedDurationMs: number;
  confidence: number; // 0-1
  sampleCount: number;
}
```

**Worker State**
```typescript
interface WorkerState {
  workerId: string;
  currentLoad: number; // 0-1
  queueDepth: number;
  lastHeartbeat: Date;
  estimatedAvailableAt: Date;
}
```

**Scheduling Decision**
```typescript
interface SchedulingDecision {
  taskId: string;
  workerId: string;
  predictedWaitMs: number;
  predictedDurationMs: number;
  score: number;
  reasoning: string; // For audit log
}
```

### Prediction Algorithm (Heuristic)

1. **Task Duration**: Exponential moving average (EMA) with α=0.3
   - `newEMA = α * actual + (1-α) * previousEMA`
   - Fallback: 5000ms for unknown task types

2. **Worker Availability**: Current load + (queue depth × avg task duration)
   - Decay factor applied based on time since last heartbeat

3. **Scoring Function**:
   ```
   score = w1 * (1 - predictedWait/maxWait)
         + w2 * (1 - workerLoad)
         + w3 * taskPriority
   ```
   Where w1=0.4, w2=0.4, w3=0.2 (configurable)

### Integration Points

| Component | Integration | Protocol |
|-----------|-------------|----------|
| Nexus Queue | Consume tasks, dispatch | Redis Streams |
| Nexus Workers | Capacity reports, heartbeats | gRPC (existing) |
| Nexus Store | Write metrics, read history | ClickHouse client |
| Nexus API | Status endpoint, controls | REST (new endpoints) |

## Implementation Strategy

### Development Approach
1. **Vertical slice first**: Get one task scheduled predictively end-to-end
2. **Metrics before optimization**: Instrument everything before tuning
3. **Shadow mode**: Run alongside existing scheduler before replacing

### Risk Mitigation
- **Cold start**: Bootstrap with configurable defaults per task type
- **Prediction failures**: Circuit breaker triggers fallback after 3 consecutive failures
- **Latency spikes**: Pre-warm prediction cache on startup

### Testing Strategy
- Unit tests: Predictor, Scorer, Worker Registry (mocked dependencies)
- Integration tests: Full scheduling loop with Redis/workers
- Performance tests: Verify < 10ms p99 with 100 tasks/sec load

## Task Breakdown

- [ ] **Task 1: Core Scheduler Framework** - Scheduler service skeleton with Predictor interface, Worker Registry, and round-robin fallback
- [ ] **Task 2: Heuristic Predictor** - EMA-based task duration prediction with Redis persistence for warm restart
- [ ] **Task 3: Worker Capacity Tracking** - gRPC subscription to worker heartbeats, real-time capacity map
- [ ] **Task 4: Multi-Objective Scorer** - Scoring function balancing wait time, utilization, and priority
- [ ] **Task 5: Metrics & Observability** - ClickHouse integration for decision logging, Prometheus metrics export
- [ ] **Task 6: Feedback Loop** - Capture actual execution times, update predictions, detect drift
- [ ] **Task 7: API & Controls** - REST endpoints for scheduler status, manual overrides, config updates
- [ ] **Task 8: Integration & Testing** - End-to-end tests, shadow mode, performance benchmarks

## Dependencies

### Technical Prerequisites
- Redis Streams operational (existing Nexus Queue)
- ClickHouse available for metrics storage
- Worker gRPC capacity reporting enabled

### Team Coordination
- Workers team: Ensure heartbeat includes CPU/memory metrics
- API team: Reserve `/scheduler/*` endpoint namespace
- Observability: Dashboard template for scheduler metrics

## Success Criteria (Technical)

| Criteria | Target | Validation |
|----------|--------|------------|
| Scheduling latency | < 10ms p99 | Load test with 100 tasks/sec |
| Prediction accuracy | 80% within 25% of actual | Compare predicted vs actual over 1000 tasks |
| Fallback reliability | 100% availability | Inject prediction failures, verify fallback |
| Worker utilization spread | < 15% variance | Monitor fleet utilization over 1 hour |

### Quality Gates
- All unit tests pass
- Integration tests pass with real Redis
- Performance test confirms latency targets
- Shadow mode shows improvement over round-robin

## Estimated Effort

| Task | Complexity | Notes |
|------|------------|-------|
| Core Scheduler Framework | Medium | Service setup, interfaces |
| Heuristic Predictor | Low | Simple EMA math |
| Worker Capacity Tracking | Medium | gRPC integration |
| Multi-Objective Scorer | Low | Pure function |
| Metrics & Observability | Medium | ClickHouse schema, queries |
| Feedback Loop | Low | Event subscription |
| API & Controls | Low | Standard REST endpoints |
| Integration & Testing | Medium | E2E tests, perf tests |

**Critical Path**: Tasks 1 → 2 → 3 → 4 → 6 (core scheduling loop)

**Parallelizable**: Task 5 (Metrics) and Task 7 (API) can proceed independently after Task 1

## Tasks Created

- [ ] #2 - Core Scheduler Framework (parallel: false) - Foundation task
- [ ] #3 - Heuristic Predictor (parallel: false) - Depends on #2
- [ ] #4 - Worker Capacity Tracking (parallel: true) - Depends on #2
- [ ] #5 - Multi-Objective Scorer (parallel: false) - Depends on #3, #4
- [ ] #6 - Metrics & Observability (parallel: true) - Depends on #2
- [ ] #7 - Feedback Loop (parallel: false) - Depends on #3, #5
- [ ] #8 - API & Controls (parallel: true) - Depends on #2
- [ ] #9 - Integration & Testing (parallel: false) - Depends on #5, #6, #7, #8

**Total tasks:** 8
**Parallel tasks:** 3 (#4, #6, #8 can run concurrently after #2)
**Sequential tasks:** 5
**Estimated total effort:** 44-64 hours

### Dependency Graph
```
#2 (Core Framework)
 ├── #3 (Predictor)
 │    └── #5 (Scorer) ─────┐
 │         └── #7 (Feedback)──┤
 ├── #4 (Worker Tracking) ──┘  │
 ├── #6 (Metrics) ─────────────┤
 └── #8 (API) ─────────────────┤
                               ▼
                    #9 (Integration & Testing)
```
