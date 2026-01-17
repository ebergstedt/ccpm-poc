---
name: task-scheduler
description: Predictive task scheduler with ML-based optimization for efficient worker resource utilization
status: backlog
created: 2026-01-17T08:56:59Z
---

# PRD: task-scheduler

## Executive Summary

The Predictive Task Scheduler replaces the existing Nexus Scheduler with an intelligent, ML-enhanced scheduling system that optimizes task distribution across worker nodes. By leveraging historical execution data, real-time worker capacity metrics, and task characteristics, the scheduler predicts optimal task placement to maximize worker utilization while minimizing latency and ensuring predictable performance.

This is a full replacement of the current scheduler, designed for latency-sensitive environments (< 10ms scheduling decisions) at small scale (< 100 tasks/sec), with a pragmatic approach: start with simple heuristics and evolve toward more sophisticated ML models as data accumulates.

## Problem Statement

### Current State
The existing Nexus Scheduler distributes tasks across workers using basic round-robin or priority-based assignment. This leads to:

- **Uneven worker utilization**: Some workers are overloaded while others sit idle
- **Unpredictable completion times**: Same task type can take vastly different times depending on placement
- **Reactive bottlenecks**: Problems are only detected after they cause delays
- **No learning**: The scheduler doesn't improve based on historical patterns

### Why Now
As Nexus scales, inefficient scheduling compounds into:
- Wasted compute resources and higher infrastructure costs
- Unpredictable SLAs making capacity planning difficult
- Developer frustration with inconsistent task performance
- Inability to optimize for different workload patterns

### Impact
Solving this enables:
- Higher throughput without adding workers
- Predictable task completion times for better user experience
- Data-driven capacity planning
- Foundation for advanced features (auto-scaling, cost optimization)

## User Stories

### Primary Personas

**1. Platform Operator**
- Manages Nexus deployment and worker fleet
- Needs visibility into scheduler decisions and resource utilization
- Wants predictable, efficient resource usage

**2. Application Developer**
- Submits tasks through Nexus SDK
- Expects consistent, fast task execution
- Wants to understand why tasks take the time they do

**3. SRE/DevOps Engineer**
- Monitors system health and performance
- Needs to troubleshoot scheduling issues
- Requires clear observability into scheduler behavior

### User Journeys

#### US-1: Predictable Task Execution
**As an** Application Developer
**I want** my tasks to complete in predictable timeframes
**So that** I can set accurate expectations with my users

**Acceptance Criteria:**
- Task completion time variance reduced by 50% compared to current scheduler
- Estimated completion time provided at submission with 80% accuracy
- Historical performance data accessible for capacity planning

#### US-2: Efficient Resource Utilization
**As a** Platform Operator
**I want** workers to be evenly utilized
**So that** I minimize infrastructure costs while maintaining performance

**Acceptance Criteria:**
- Worker utilization variance < 15% across the fleet
- No worker sits idle while tasks are queued (unless affinity constraints)
- Dashboard shows real-time utilization across all workers

#### US-3: Transparent Scheduling Decisions
**As an** SRE
**I want** to understand why tasks were scheduled where they were
**So that** I can troubleshoot issues and optimize the system

**Acceptance Criteria:**
- Every scheduling decision is logged with reasoning
- Metrics available showing prediction accuracy over time
- Ability to replay scheduling decisions for debugging

#### US-4: Adaptive Learning
**As a** Platform Operator
**I want** the scheduler to improve over time
**So that** performance gets better without manual tuning

**Acceptance Criteria:**
- Prediction accuracy improves measurably over first 30 days
- System adapts to new task types within 24 hours
- Manual override capability when predictions are wrong

## Requirements

### Functional Requirements

#### FR-1: Prediction Engine
- **FR-1.1**: Predict task execution time based on task type, payload size, and historical data
- **FR-1.2**: Predict worker capacity based on current load, historical patterns, and resource metrics
- **FR-1.3**: Start with heuristic-based predictions (moving averages, percentile-based estimates)
- **FR-1.4**: Support pluggable prediction models for future ML integration

#### FR-2: Scheduling Algorithm
- **FR-2.1**: Score potential worker assignments using multi-factor optimization
- **FR-2.2**: Balance throughput, latency, and utilization objectives
- **FR-2.3**: Respect existing constraints (affinity, resource requirements, priority)
- **FR-2.4**: Support task preemption for high-priority work (configurable)

#### FR-3: Data Collection
- **FR-3.1**: Capture task execution metrics (queue time, execution time, result size)
- **FR-3.2**: Capture worker metrics (CPU, memory, network, queue depth)
- **FR-3.3**: Store historical data for prediction model training
- **FR-3.4**: Aggregate metrics for real-time decision making

#### FR-4: Reactive Adjustments
- **FR-4.1**: Detect when actual performance deviates significantly from predictions
- **FR-4.2**: Re-schedule pending tasks when worker conditions change
- **FR-4.3**: Circuit breaker for workers showing degraded performance
- **FR-4.4**: Feedback loop to update predictions based on actual results

#### FR-5: Observability
- **FR-5.1**: Export scheduling metrics (decisions/sec, prediction accuracy, queue depths)
- **FR-5.2**: Distributed tracing integration for end-to-end visibility
- **FR-5.3**: Decision audit log with full context
- **FR-5.4**: Real-time dashboard for scheduler health

### Non-Functional Requirements

#### NFR-1: Performance
- **NFR-1.1**: Scheduling decisions must complete in < 10ms (p99)
- **NFR-1.2**: Support throughput of 100 tasks/second sustained
- **NFR-1.3**: Prediction model inference < 1ms per task
- **NFR-1.4**: No scheduling decision should block on external I/O

#### NFR-2: Reliability
- **NFR-2.1**: Graceful degradation to simple round-robin if prediction fails
- **NFR-2.2**: No task loss during scheduler restarts
- **NFR-2.3**: Consistent behavior across scheduler replicas
- **NFR-2.4**: Recovery time < 5 seconds after failure

#### NFR-3: Scalability
- **NFR-3.1**: Horizontal scaling of scheduler instances
- **NFR-3.2**: Support up to 1000 worker nodes
- **NFR-3.3**: Historical data retention configurable (default: 30 days)
- **NFR-3.4**: Prediction model updates without service disruption

#### NFR-4: Security
- **NFR-4.1**: No sensitive data in scheduling decisions or logs
- **NFR-4.2**: Rate limiting on scheduler API
- **NFR-4.3**: Audit trail for configuration changes

## Technical Design Considerations

### Prediction Approach (Phase 1: Heuristics)
1. **Task Duration Prediction**: Exponential moving average of last N executions by task type
2. **Worker Capacity Prediction**: Current load + decay factor based on queue depth
3. **Scoring Function**: Weighted combination of predicted wait time, worker utilization, and priority

### Data Flow
```
Task Submitted → Prediction Engine → Scorer → Worker Selection → Dispatch
                      ↑                              ↓
                Historical Data ←──────── Execution Results
```

### Integration Points
- **Nexus Queue**: Consumes tasks, dispatches to workers
- **Nexus Store**: Reads/writes historical metrics
- **Nexus Workers**: Receives capacity reports via gRPC
- **Nexus API**: Exposes scheduler status and controls

## Success Criteria

### Primary Metrics

| Metric | Current Baseline | Target | Measurement Method |
|--------|-----------------|--------|-------------------|
| Completion Time Variance | TBD | < 20% coefficient of variation | Std dev / mean of task duration by type |
| Prediction Accuracy | N/A | 80% within 25% of actual | (Predicted - Actual) / Actual |
| Worker Utilization Spread | TBD | < 15% variance | Max - Min utilization across workers |
| Scheduling Latency | TBD | < 10ms p99 | Time from task arrival to dispatch |

### Secondary Metrics
- Scheduler availability: 99.9%
- Time to adapt to new task type: < 24 hours
- Prediction model update frequency: Daily minimum

### Validation Approach
1. A/B testing: Run predictive scheduler on subset of traffic
2. Shadow mode: Log what predictive scheduler would do, compare to actual
3. Gradual rollout: 10% → 50% → 100% of traffic

## Constraints & Assumptions

### Constraints
- **Latency budget**: Must make decisions in < 10ms to not become bottleneck
- **Existing infrastructure**: Must work with current Redis Streams queue implementation
- **No external ML services**: Predictions must run locally (no API calls to ML services)
- **Backward compatibility**: Must support existing task submission API

### Assumptions
- Historical execution data will be representative of future behavior
- Worker capacity metrics are accurate and timely (< 1 second delay)
- Task types are relatively stable (not thousands of unique types)
- Network latency between scheduler and workers is negligible

### Risks
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Predictions consistently wrong | Medium | High | Fallback to round-robin, continuous learning |
| Latency budget exceeded | Low | High | Pre-compute predictions, cache aggressively |
| Cold start (no historical data) | Certain | Medium | Bootstrap with sensible defaults |

## Out of Scope

The following are explicitly **NOT** included in this PRD:

- **Advanced ML models**: Neural networks, reinforcement learning (future phase)
- **Auto-scaling**: Automatic worker fleet scaling based on predictions
- **Cost optimization**: Multi-cloud or spot instance aware scheduling
- **Task splitting**: Breaking large tasks into smaller units
- **Cross-region scheduling**: Scheduling across geographically distributed workers
- **User-facing prediction API**: Exposing predictions to end users

## Dependencies

### Internal Dependencies
| Component | Dependency Type | Description |
|-----------|----------------|-------------|
| Nexus Queue | Integration | Task dispatch and completion signals |
| Nexus Store | Integration | Historical metrics storage (ClickHouse) |
| Nexus Workers | Integration | Capacity reporting via gRPC |
| Nexus API | Integration | Scheduler controls and status endpoints |

### External Dependencies
| Dependency | Purpose | Risk |
|------------|---------|------|
| Redis | State and caching | Existing dependency, low risk |
| ClickHouse | Metrics storage | Existing dependency, low risk |

### Team Dependencies
- Platform team for worker capacity reporting enhancements
- Observability team for metrics pipeline integration

## Implementation Phases

### Phase 1: Foundation (MVP)
- Heuristic-based predictions (moving averages)
- Single-objective optimization (minimize wait time)
- Basic observability (metrics, logs)
- Fallback to round-robin on failure

### Phase 2: Learning
- Continuous learning from execution results
- Multi-objective optimization
- Reactive re-scheduling
- Enhanced dashboard

### Phase 3: Intelligence (Future)
- ML-based predictions
- Anomaly detection
- Predictive auto-scaling recommendations
- What-if analysis tools

## Appendix

### Glossary
- **Scheduling Decision**: The assignment of a task to a specific worker
- **Prediction Accuracy**: How close predicted values are to actual outcomes
- **Worker Utilization**: Percentage of worker capacity being used
- **Queue Depth**: Number of tasks waiting to be processed

### References
- Current Nexus Scheduler implementation: `src/scheduler/`
- Worker capacity reporting: `src/workers/capacity.ts`
- Metrics pipeline: `src/store/metrics/`
