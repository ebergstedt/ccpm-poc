/**
 * Unit tests for HeartbeatSubscriber
 */

import { EventEmitter } from 'events';
import {
  HeartbeatSubscriber,
  GrpcHeartbeatStream,
  HeartbeatSubscriberConfig,
} from './heartbeat-subscriber';
import { WorkerRegistry } from './worker-registry';
import { WorkerHeartbeat, WorkerState, WorkerStateEvent } from '../interfaces/types';

/**
 * Mock gRPC stream for testing
 */
class MockGrpcStream extends EventEmitter implements GrpcHeartbeatStream {
  private cancelled = false;

  cancel(): void {
    this.cancelled = true;
    this.emit('end');
  }

  isCancelled(): boolean {
    return this.cancelled;
  }

  // Simulate receiving heartbeat data
  simulateHeartbeat(heartbeat: WorkerHeartbeat): void {
    this.emit('data', heartbeat);
  }

  // Simulate stream error
  simulateError(error: Error): void {
    this.emit('error', error);
  }

  // Simulate stream end
  simulateEnd(): void {
    this.emit('end');
  }
}

describe('HeartbeatSubscriber', () => {
  let registry: WorkerRegistry;
  let subscriber: HeartbeatSubscriber;
  let mockStream: MockGrpcStream;

  const createWorker = (
    id: string,
    overrides: Partial<WorkerState> = {}
  ): WorkerState => ({
    id,
    status: 'idle',
    capabilities: ['default'],
    currentLoad: 0,
    lastHeartbeat: new Date(),
    activeTasks: 0,
    maxConcurrency: 10,
    ...overrides,
  });

  const createHeartbeat = (
    workerId: string,
    overrides: Partial<WorkerHeartbeat> = {}
  ): WorkerHeartbeat => ({
    workerId,
    cpuUsage: 0.5,
    memoryUsage: 0.5,
    queueDepth: 0,
    timestampMs: Date.now(),
    ...overrides,
  });

  beforeEach(() => {
    registry = new WorkerRegistry(30000);
    subscriber = new HeartbeatSubscriber(registry, {
      healthCheckIntervalMs: 100, // Fast for testing
    });
    mockStream = new MockGrpcStream();
  });

  afterEach(() => {
    subscriber.unsubscribe();
    registry.clear();
  });

  describe('subscribe', () => {
    it('should subscribe to gRPC stream', () => {
      subscriber.subscribe(mockStream);
      expect(subscriber.isSubscribed()).toBe(true);
    });

    it('should handle heartbeat data', () => {
      registry.register(createWorker('worker-1'));
      subscriber.subscribe(mockStream);

      const heartbeat = createHeartbeat('worker-1', {
        cpuUsage: 0.6,
        memoryUsage: 0.4,
        queueDepth: 3,
      });

      mockStream.simulateHeartbeat(heartbeat);

      const capacity = subscriber.getWorkerCapacity('worker-1');
      expect(capacity).toBeDefined();
      expect(capacity?.queueDepth).toBe(3);
      expect(capacity?.healthStatus).toBe('healthy');
    });

    it('should ignore heartbeats from unknown workers', () => {
      subscriber.subscribe(mockStream);

      const heartbeat = createHeartbeat('unknown-worker');
      mockStream.simulateHeartbeat(heartbeat);

      expect(subscriber.getWorkerCapacity('unknown-worker')).toBeUndefined();
    });

    it('should emit error events from stream', (done) => {
      subscriber.subscribe(mockStream);

      subscriber.on('error', (error) => {
        expect(error.message).toBe('Test error');
        done();
      });

      mockStream.simulateError(new Error('Test error'));
    });

    it('should emit streamEnd when stream ends', (done) => {
      subscriber.subscribe(mockStream);

      subscriber.on('streamEnd', () => {
        expect(subscriber.isSubscribed()).toBe(false);
        done();
      });

      mockStream.simulateEnd();
    });
  });

  describe('unsubscribe', () => {
    it('should cancel the stream and stop health checks', () => {
      subscriber.subscribe(mockStream);
      expect(subscriber.isSubscribed()).toBe(true);

      subscriber.unsubscribe();

      expect(subscriber.isSubscribed()).toBe(false);
      expect(mockStream.isCancelled()).toBe(true);
    });

    it('should handle unsubscribe when not subscribed', () => {
      expect(() => subscriber.unsubscribe()).not.toThrow();
    });
  });

  describe('worker state change events', () => {
    it('should emit worker_degraded when load exceeds threshold', (done) => {
      registry.register(createWorker('worker-1'));
      subscriber.subscribe(mockStream);

      // First heartbeat to establish baseline
      mockStream.simulateHeartbeat(createHeartbeat('worker-1', {
        cpuUsage: 0.5,
        memoryUsage: 0.5,
      }));

      subscriber.on('workerStateChange', (event: WorkerStateEvent) => {
        if (event.type === 'worker_degraded') {
          expect(event.workerId).toBe('worker-1');
          expect(event.load).toBeGreaterThanOrEqual(0.9);
          done();
        }
      });

      // High load heartbeat
      mockStream.simulateHeartbeat(createHeartbeat('worker-1', {
        cpuUsage: 0.95,
        memoryUsage: 0.95,
      }));
    });

    it('should emit worker_healthy when recovering from degraded', (done) => {
      registry.register(createWorker('worker-1'));
      subscriber.subscribe(mockStream);

      let sawDegraded = false;
      subscriber.on('workerStateChange', (event: WorkerStateEvent) => {
        if (event.type === 'worker_degraded') {
          sawDegraded = true;
          // Send recovery heartbeat after degraded is registered
          setImmediate(() => {
            mockStream.simulateHeartbeat(createHeartbeat('worker-1', {
              cpuUsage: 0.3,
              memoryUsage: 0.3,
            }));
          });
        }
        if (event.type === 'worker_healthy' && sawDegraded) {
          expect(event.workerId).toBe('worker-1');
          done();
        }
      });

      // Start with high load (degraded)
      mockStream.simulateHeartbeat(createHeartbeat('worker-1', {
        cpuUsage: 0.95,
        memoryUsage: 0.95,
      }));
    });

    it('should emit worker_load_changed on significant load change', (done) => {
      registry.register(createWorker('worker-1'));
      subscriber.subscribe(mockStream);

      // First heartbeat to establish baseline
      mockStream.simulateHeartbeat(createHeartbeat('worker-1', {
        cpuUsage: 0.2,
        memoryUsage: 0.2,
      }));

      subscriber.on('workerStateChange', (event: WorkerStateEvent) => {
        if (event.type === 'worker_load_changed') {
          expect(event.workerId).toBe('worker-1');
          expect(event.previousLoad).toBeLessThan(0.3);
          expect(event.currentLoad).toBeGreaterThan(0.5);
          done();
        }
      });

      // Significant load increase
      mockStream.simulateHeartbeat(createHeartbeat('worker-1', {
        cpuUsage: 0.8,
        memoryUsage: 0.7,
      }));
    });
  });

  describe('health check', () => {
    // Note: These tests verify the availability calculator's timeout logic
    // The integration with the health check interval is covered by the
    // AvailabilityCalculator unit tests

    it('should detect unhealthy status from calculator', () => {
      const config: HeartbeatSubscriberConfig = {
        unhealthyTimeoutMs: 50,
        removedTimeoutMs: 500,
        healthCheckIntervalMs: 100,
      };
      subscriber = new HeartbeatSubscriber(registry, config);

      const calculator = subscriber.getCalculator();

      // Check that stale heartbeat is detected as unhealthy
      const staleHeartbeat = Date.now() - 100; // 100ms ago
      expect(calculator.shouldMarkUnhealthy(staleHeartbeat)).toBe(true);

      // Check that recent heartbeat is not unhealthy
      const recentHeartbeat = Date.now() - 10; // 10ms ago
      expect(calculator.shouldMarkUnhealthy(recentHeartbeat)).toBe(false);
    });

    it('should detect removal status from calculator', () => {
      const config: HeartbeatSubscriberConfig = {
        unhealthyTimeoutMs: 50,
        removedTimeoutMs: 100,
        healthCheckIntervalMs: 100,
      };
      subscriber = new HeartbeatSubscriber(registry, config);

      const calculator = subscriber.getCalculator();

      // Check that very stale heartbeat triggers removal
      const veryStaleHeartbeat = Date.now() - 200; // 200ms ago
      expect(calculator.shouldRemoveWorker(veryStaleHeartbeat)).toBe(true);

      // Check that somewhat stale heartbeat does not trigger removal
      const somewhatlStaleHeartbeat = Date.now() - 80; // 80ms ago
      expect(calculator.shouldRemoveWorker(somewhatlStaleHeartbeat)).toBe(false);
    });

    it('should use configured thresholds for health detection', () => {
      const config: HeartbeatSubscriberConfig = {
        unhealthyTimeoutMs: 1000,  // 1 second
        removedTimeoutMs: 5000,    // 5 seconds
        healthCheckIntervalMs: 100,
      };
      subscriber = new HeartbeatSubscriber(registry, config);

      const calculator = subscriber.getCalculator();

      // 500ms ago should NOT be unhealthy with 1000ms threshold
      expect(calculator.shouldMarkUnhealthy(Date.now() - 500)).toBe(false);

      // 1500ms ago SHOULD be unhealthy with 1000ms threshold
      expect(calculator.shouldMarkUnhealthy(Date.now() - 1500)).toBe(true);

      // 3000ms ago should NOT trigger removal with 5000ms threshold
      expect(calculator.shouldRemoveWorker(Date.now() - 3000)).toBe(false);

      // 6000ms ago SHOULD trigger removal with 5000ms threshold
      expect(calculator.shouldRemoveWorker(Date.now() - 6000)).toBe(true);
    });
  });

  describe('getWorkerCapacity', () => {
    it('should return capacity for known workers', () => {
      registry.register(createWorker('worker-1'));
      subscriber.subscribe(mockStream);

      mockStream.simulateHeartbeat(createHeartbeat('worker-1', {
        queueDepth: 5,
      }));

      const capacity = subscriber.getWorkerCapacity('worker-1');
      expect(capacity).toBeDefined();
      expect(capacity?.queueDepth).toBe(5);
    });

    it('should return undefined for unknown workers', () => {
      expect(subscriber.getWorkerCapacity('unknown')).toBeUndefined();
    });
  });

  describe('getAllWorkerCapacities', () => {
    it('should return all worker capacities', () => {
      registry.register(createWorker('worker-1'));
      registry.register(createWorker('worker-2'));
      subscriber.subscribe(mockStream);

      mockStream.simulateHeartbeat(createHeartbeat('worker-1', { queueDepth: 3 }));
      mockStream.simulateHeartbeat(createHeartbeat('worker-2', { queueDepth: 5 }));

      const capacities = subscriber.getAllWorkerCapacities();
      expect(capacities.size).toBe(2);
      expect(capacities.get('worker-1')?.queueDepth).toBe(3);
      expect(capacities.get('worker-2')?.queueDepth).toBe(5);
    });
  });

  describe('getCalculator', () => {
    it('should return the availability calculator', () => {
      const calculator = subscriber.getCalculator();
      expect(calculator).toBeDefined();
      expect(calculator.getAvgTaskDuration()).toBeDefined();
    });
  });

  describe('resubscribe', () => {
    it('should cancel old stream when resubscribing', () => {
      subscriber.subscribe(mockStream);

      const newStream = new MockGrpcStream();
      subscriber.subscribe(newStream);

      expect(mockStream.isCancelled()).toBe(true);
      expect(subscriber.isSubscribed()).toBe(true);
    });
  });
});
