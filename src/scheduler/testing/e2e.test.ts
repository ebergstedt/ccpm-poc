/**
 * End-to-End Tests for Predictive Scheduler
 */

import { Task, WorkerState, SchedulingDecision } from '../interfaces/types';
import { HeuristicPredictor } from '../predictor/heuristic-predictor';
import { MultiObjectiveScorer } from '../scorer/scorer';
import { WorkerRegistry } from '../registry/worker-registry';
import { CompletionSubscriber, TaskCompletion } from '../feedback/completion-subscriber';
import { ShadowScheduler } from './shadow-mode';
import { Benchmark } from './benchmark';
import { ChaosRunner } from './chaos';

// Mock redis for tests
jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  })),
}));

describe('E2E: Predictive Scheduler', () => {
  let predictor: HeuristicPredictor;
  let scorer: MultiObjectiveScorer;
  let registry: WorkerRegistry;
  let completionSubscriber: CompletionSubscriber;

  const createTask = (id: string, type: string = 'default', priority: number = 5): Task => ({
    id,
    type,
    payload: {},
    priority,
    createdAt: new Date(),
  });

  const createWorker = (id: string, load: number = 0): WorkerState => ({
    id,
    status: 'idle',
    capabilities: [],
    currentLoad: load,
    lastHeartbeat: new Date(),
    activeTasks: Math.floor(load * 10),
    maxConcurrency: 10,
  });

  beforeEach(async () => {
    predictor = new HeuristicPredictor({ redisUrl: 'redis://localhost:6379' });
    await predictor.initialize();

    scorer = new MultiObjectiveScorer();
    registry = new WorkerRegistry(30000);

    completionSubscriber = new CompletionSubscriber();
    completionSubscriber.setPredictor(predictor);
    completionSubscriber.start();

    // Register workers
    registry.register(createWorker('worker-1', 0.2));
    registry.register(createWorker('worker-2', 0.5));
    registry.register(createWorker('worker-3', 0.8));
  });

  afterEach(async () => {
    completionSubscriber.stop();
    await predictor.shutdown();
    registry.clear();
  });

  describe('Scenario 1: Happy Path', () => {
    it('should schedule task and learn from completion', async () => {
      // 1. Submit task
      const task = createTask('task-1', 'fast-task', 5);

      // 2. Get prediction (cold start - default)
      const prediction = await predictor.predict(task);
      expect(prediction).not.toBeNull();
      expect(prediction!.estimatedDurationMs).toBe(5000); // Default
      expect(prediction!.confidence).toBe(0); // No samples yet

      // 3. Score workers
      const workers = registry.getAvailable();
      const result = scorer.score(task, workers, prediction);
      expect(result).not.toBeNull();
      expect(result!.workerId).toBeDefined();

      // 4. Simulate task completion
      const completion: TaskCompletion = {
        taskId: 'task-1',
        taskType: 'fast-task',
        workerId: result!.workerId,
        startedAt: new Date(),
        completedAt: new Date(),
        durationMs: 1000, // Actual duration
        success: true,
        predictedDurationMs: prediction!.estimatedDurationMs,
      };

      await completionSubscriber.processCompletion(completion);

      // 5. Verify learning
      const newPrediction = await predictor.predict(createTask('task-2', 'fast-task'));
      expect(newPrediction!.estimatedDurationMs).toBe(1000); // Learned actual
      expect(newPrediction!.confidence).toBe(0.01); // 1/100 samples
    });
  });

  describe('Scenario 2: Cold Start', () => {
    it('should use fallback initially then learn', async () => {
      // Cold start - no predictions
      const task = createTask('task-1', 'unknown-type');
      const prediction = await predictor.predict(task);

      expect(prediction!.estimatedDurationMs).toBe(5000);
      expect(prediction!.confidence).toBe(0);

      // Fallback would be used (simulated)
      const workers = registry.getAvailable();
      const result = scorer.score(task, workers, prediction);
      expect(result).not.toBeNull();

      // After several completions, predictions improve
      for (let i = 0; i < 10; i++) {
        await completionSubscriber.processCompletion({
          taskId: `task-${i}`,
          taskType: 'unknown-type',
          workerId: 'worker-1',
          startedAt: new Date(),
          completedAt: new Date(),
          durationMs: 2000 + i * 100, // Vary slightly
          success: true,
          predictedDurationMs: 5000,
        });
      }

      // Prediction should now be closer to actual
      const learnedPrediction = await predictor.predict(task);
      expect(learnedPrediction!.estimatedDurationMs).toBeLessThan(4000);
      expect(learnedPrediction!.confidence).toBe(0.1); // 10/100 samples
    });
  });

  describe('Scenario 3: Worker Failure', () => {
    it('should exclude unhealthy workers from scheduling', async () => {
      // Mark worker-1 as offline
      registry.updateStatus('worker-1', 'offline');

      const task = createTask('task-1');
      const prediction = await predictor.predict(task);
      const workers = registry.getAvailable();
      const result = scorer.score(task, workers, prediction);

      // Should not select offline worker
      expect(result).not.toBeNull();
      expect(result!.workerId).not.toBe('worker-1');
    });

    it('should handle all workers unhealthy', () => {
      registry.updateStatus('worker-1', 'offline');
      registry.updateStatus('worker-2', 'offline');
      registry.updateStatus('worker-3', 'offline');

      const task = createTask('task-1');
      const workers = registry.getAvailable();

      expect(workers).toHaveLength(0);

      // Scorer should return null
      const result = scorer.score(task, workers, null);
      expect(result).toBeNull();
    });
  });

  describe('Scenario 4: High Load Distribution', () => {
    it('should distribute tasks across workers evenly', async () => {
      const assignments = new Map<string, number>();

      // Schedule 100 tasks with load updates to simulate real behavior
      for (let i = 0; i < 100; i++) {
        const task = createTask(`task-${i}`);
        const prediction = await predictor.predict(task);
        const workers = registry.getAvailable();
        const result = scorer.score(task, workers, prediction);

        if (result) {
          const count = assignments.get(result.workerId) || 0;
          assignments.set(result.workerId, count + 1);

          // Update worker load to simulate task assignment
          const worker = registry.get(result.workerId);
          if (worker) {
            const newLoad = Math.min(1, worker.currentLoad + 0.05);
            registry.updateLoad(result.workerId, newLoad, worker.activeTasks + 1);
          }
        }
      }

      // Check distribution - should favor less loaded workers
      const counts = Array.from(assignments.values());
      expect(counts.length).toBeGreaterThan(1);

      // Worker-1 (lowest initial load) should get most tasks
      expect(assignments.get('worker-1')).toBeGreaterThanOrEqual(
        assignments.get('worker-3') || 0
      );
    });
  });

  describe('Scenario 5: Priority Handling', () => {
    it('should handle priority in scoring', async () => {
      // Create scorer that heavily weights priority
      const priorityScorer = new MultiObjectiveScorer({
        weights: { wait: 0.1, load: 0.1, priority: 0.8 },
      });

      const lowPriorityTask = createTask('low', 'type', 1);
      const highPriorityTask = createTask('high', 'type', 10);

      const workers = registry.getAvailable();

      const lowResult = priorityScorer.score(lowPriorityTask, workers, null);
      const highResult = priorityScorer.score(highPriorityTask, workers, null);

      // High priority should have higher score
      expect(highResult!.score).toBeGreaterThan(lowResult!.score);
    });
  });
});

describe('E2E: Shadow Mode', () => {
  let predictor: HeuristicPredictor;
  let scorer: MultiObjectiveScorer;
  let registry: WorkerRegistry;
  let shadowScheduler: ShadowScheduler;

  beforeEach(async () => {
    predictor = new HeuristicPredictor({ redisUrl: 'redis://localhost:6379' });
    await predictor.initialize();

    scorer = new MultiObjectiveScorer();
    registry = new WorkerRegistry(30000);
    shadowScheduler = new ShadowScheduler(predictor, scorer, registry);

    registry.register({
      id: 'worker-1',
      status: 'idle',
      capabilities: [],
      currentLoad: 0.3,
      lastHeartbeat: new Date(),
      activeTasks: 3,
      maxConcurrency: 10,
    });
    registry.register({
      id: 'worker-2',
      status: 'idle',
      capabilities: [],
      currentLoad: 0.6,
      lastHeartbeat: new Date(),
      activeTasks: 6,
      maxConcurrency: 10,
    });
  });

  afterEach(async () => {
    await predictor.shutdown();
  });

  it('should compare predictive vs actual decisions', async () => {
    shadowScheduler.enable();

    const task: Task = {
      id: 'task-1',
      type: 'test',
      payload: {},
      priority: 5,
      createdAt: new Date(),
    };

    const actualDecision: SchedulingDecision = {
      taskId: 'task-1',
      workerId: 'worker-2',
      timestamp: new Date(),
      usedFallback: true,
      reason: 'fallback_round_robin',
    };

    const result = await shadowScheduler.shadow(task, actualDecision);

    expect(result.taskId).toBe('task-1');
    expect(result.predictive).not.toBeNull();
    expect(result.actual?.workerId).toBe('worker-2');
    // Predictive should prefer worker-1 (lower load)
    expect(result.predictive?.workerId).toBe('worker-1');
    expect(result.match).toBe(false);
  });

  it('should track statistics', async () => {
    shadowScheduler.enable();

    // Run several comparisons
    for (let i = 0; i < 10; i++) {
      const task: Task = {
        id: `task-${i}`,
        type: 'test',
        payload: {},
        priority: 5,
        createdAt: new Date(),
      };

      const actualDecision: SchedulingDecision = {
        taskId: `task-${i}`,
        workerId: i % 2 === 0 ? 'worker-1' : 'worker-2',
        timestamp: new Date(),
        usedFallback: true,
        reason: 'fallback_round_robin',
      };

      await shadowScheduler.shadow(task, actualDecision);
    }

    const stats = shadowScheduler.getStats();
    expect(stats.total).toBe(10);
    expect(stats.matchRate).toBeGreaterThanOrEqual(0);
    expect(stats.matchRate).toBeLessThanOrEqual(1);
  });
});

describe('E2E: Performance Benchmarks', () => {
  let predictor: HeuristicPredictor;
  let scorer: MultiObjectiveScorer;
  let registry: WorkerRegistry;
  let benchmark: Benchmark;

  const taskGenerator = (): Task => ({
    id: `task-${Math.random().toString(36).substr(2, 9)}`,
    type: 'benchmark-task',
    payload: {},
    priority: Math.floor(Math.random() * 10) + 1,
    createdAt: new Date(),
  });

  beforeEach(async () => {
    predictor = new HeuristicPredictor({ redisUrl: 'redis://localhost:6379' });
    await predictor.initialize();

    scorer = new MultiObjectiveScorer();
    registry = new WorkerRegistry(30000);
    benchmark = new Benchmark({
      targetThroughput: 100,
      targetP99: 10,
      durationMs: 1000, // Short for tests
      warmupMs: 100,
    });

    // Register workers
    for (let i = 0; i < 10; i++) {
      registry.register({
        id: `worker-${i}`,
        status: 'idle',
        capabilities: [],
        currentLoad: Math.random() * 0.8,
        lastHeartbeat: new Date(),
        activeTasks: Math.floor(Math.random() * 5),
        maxConcurrency: 10,
      });
    }
  });

  afterEach(async () => {
    await predictor.shutdown();
  });

  it('should meet predictor latency target (< 1ms p99)', async () => {
    const result = await benchmark.runPredictorBenchmark(predictor, taskGenerator);

    expect(result.latency.p99).toBeLessThan(1);
    expect(result.samples).toBeGreaterThan(100);
  });

  it('should meet scheduling latency target (< 10ms p99)', async () => {
    const result = await benchmark.runSchedulingBenchmark(
      scorer,
      predictor,
      registry,
      taskGenerator
    );

    expect(result.latency.p99).toBeLessThan(10);
    expect(result.samples).toBeGreaterThan(100);
  });
});

describe('E2E: Chaos Tests', () => {
  let predictor: HeuristicPredictor;
  let chaosRunner: ChaosRunner;
  let registry: WorkerRegistry;

  const taskGenerator = (): Task => ({
    id: `task-${Math.random().toString(36).substr(2, 9)}`,
    type: 'chaos-task',
    payload: {},
    priority: 5,
    createdAt: new Date(),
  });

  const fallbackHandler = async (_task: Task): Promise<string | null> => {
    // Simple fallback - return first available worker
    const workers = registry.getAvailable();
    return workers.length > 0 ? workers[0].id : null;
  };

  beforeEach(async () => {
    predictor = new HeuristicPredictor({ redisUrl: 'redis://localhost:6379' });
    await predictor.initialize();

    chaosRunner = new ChaosRunner();
    registry = new WorkerRegistry(30000);

    registry.register({
      id: 'worker-1',
      status: 'idle',
      capabilities: [],
      currentLoad: 0.3,
      lastHeartbeat: new Date(),
      activeTasks: 3,
      maxConcurrency: 10,
    });
  });

  afterEach(async () => {
    await predictor.shutdown();
  });

  it('should trigger fallback on prediction failures', async () => {
    const result = await chaosRunner.testPredictorFailure(
      predictor,
      taskGenerator,
      fallbackHandler,
      10
    );

    expect(result.passed).toBe(true);
    expect(result.fallbackTriggered).toBe(true);
    expect(result.failedRequests).toBe(10);
  });

  it('should handle partial failures gracefully', async () => {
    const result = await chaosRunner.testPartialFailure(
      predictor,
      taskGenerator,
      fallbackHandler,
      100,
      0.5
    );

    expect(result.fallbackTriggered).toBe(true);
    expect(result.failedRequests).toBeGreaterThan(30); // At least ~30% failed
    expect(result.failedRequests).toBeLessThan(70); // At most ~70% failed
  });

  it('should handle timeouts', async () => {
    const result = await chaosRunner.testTimeoutHandling(
      predictor,
      taskGenerator,
      50, // 50ms timeout
      5
    );

    expect(result.failedRequests).toBe(5);
  });
});
