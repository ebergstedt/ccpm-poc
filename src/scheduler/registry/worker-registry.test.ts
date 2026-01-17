/**
 * Unit tests for WorkerRegistry
 */

import { WorkerRegistry } from './worker-registry';
import { WorkerState } from '../interfaces/types';

describe('WorkerRegistry', () => {
  let registry: WorkerRegistry;

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

  beforeEach(() => {
    registry = new WorkerRegistry(30000);
  });

  afterEach(() => {
    registry.clear();
  });

  describe('register', () => {
    it('should register a new worker', () => {
      const worker = createWorker('worker-1');
      registry.register(worker);

      expect(registry.size()).toBe(1);
      expect(registry.get('worker-1')).toBeDefined();
    });

    it('should update existing worker on re-registration', () => {
      const worker = createWorker('worker-1', { currentLoad: 0.5 });
      registry.register(worker);

      const updatedWorker = createWorker('worker-1', { currentLoad: 0.8 });
      registry.register(updatedWorker);

      expect(registry.size()).toBe(1);
      expect(registry.get('worker-1')?.currentLoad).toBe(0.8);
    });

    it('should update lastHeartbeat on registration', () => {
      const oldDate = new Date('2020-01-01');
      const worker = createWorker('worker-1', { lastHeartbeat: oldDate });
      registry.register(worker);

      const registered = registry.get('worker-1');
      expect(registered?.lastHeartbeat.getTime()).toBeGreaterThan(oldDate.getTime());
    });
  });

  describe('unregister', () => {
    it('should remove a worker', () => {
      registry.register(createWorker('worker-1'));
      expect(registry.unregister('worker-1')).toBe(true);
      expect(registry.size()).toBe(0);
    });

    it('should return false for non-existent worker', () => {
      expect(registry.unregister('non-existent')).toBe(false);
    });
  });

  describe('get', () => {
    it('should return worker by id', () => {
      const worker = createWorker('worker-1');
      registry.register(worker);

      expect(registry.get('worker-1')).toMatchObject({
        id: 'worker-1',
        status: 'idle',
      });
    });

    it('should return undefined for non-existent worker', () => {
      expect(registry.get('non-existent')).toBeUndefined();
    });
  });

  describe('heartbeat', () => {
    it('should update worker heartbeat', async () => {
      const worker = createWorker('worker-1');
      registry.register(worker);

      const before = registry.get('worker-1')?.lastHeartbeat.getTime() || 0;

      // Small delay to ensure time difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      registry.heartbeat('worker-1');

      const after = registry.get('worker-1')?.lastHeartbeat.getTime() || 0;
      expect(after).toBeGreaterThanOrEqual(before);
    });

    it('should return false for non-existent worker', () => {
      expect(registry.heartbeat('non-existent')).toBe(false);
    });
  });

  describe('updateStatus', () => {
    it('should update worker status', () => {
      registry.register(createWorker('worker-1'));

      registry.updateStatus('worker-1', 'busy');

      expect(registry.get('worker-1')?.status).toBe('busy');
    });

    it('should return false for non-existent worker', () => {
      expect(registry.updateStatus('non-existent', 'busy')).toBe(false);
    });
  });

  describe('updateLoad', () => {
    it('should update worker load', () => {
      registry.register(createWorker('worker-1'));

      registry.updateLoad('worker-1', 0.75, 5);

      const worker = registry.get('worker-1');
      expect(worker?.currentLoad).toBe(0.75);
      expect(worker?.activeTasks).toBe(5);
    });

    it('should clamp load between 0 and 1', () => {
      registry.register(createWorker('worker-1'));

      registry.updateLoad('worker-1', 1.5, 5);
      expect(registry.get('worker-1')?.currentLoad).toBe(1);

      registry.updateLoad('worker-1', -0.5, 5);
      expect(registry.get('worker-1')?.currentLoad).toBe(0);
    });

    it('should return false for non-existent worker', () => {
      expect(registry.updateLoad('non-existent', 0.5, 5)).toBe(false);
    });
  });

  describe('getAvailable', () => {
    it('should return idle workers', () => {
      registry.register(createWorker('worker-1', { status: 'idle' }));
      registry.register(createWorker('worker-2', { status: 'busy' }));
      registry.register(createWorker('worker-3', { status: 'offline' }));

      const available = registry.getAvailable();

      expect(available).toHaveLength(2);
      expect(available.map((w) => w.id)).toContain('worker-1');
      expect(available.map((w) => w.id)).toContain('worker-2');
    });

    it('should exclude draining workers', () => {
      registry.register(createWorker('worker-1', { status: 'draining' }));

      expect(registry.getAvailable()).toHaveLength(0);
    });

    it('should exclude workers at max capacity', () => {
      registry.register(
        createWorker('worker-1', {
          activeTasks: 10,
          maxConcurrency: 10,
        })
      );

      expect(registry.getAvailable()).toHaveLength(0);
    });

    it('should filter by capabilities', () => {
      registry.register(createWorker('worker-1', { capabilities: ['gpu', 'cpu'] }));
      registry.register(createWorker('worker-2', { capabilities: ['cpu'] }));

      const gpuWorkers = registry.getAvailable(['gpu']);

      expect(gpuWorkers).toHaveLength(1);
      expect(gpuWorkers[0].id).toBe('worker-1');
    });

    it('should require all capabilities', () => {
      registry.register(createWorker('worker-1', { capabilities: ['gpu'] }));
      registry.register(createWorker('worker-2', { capabilities: ['gpu', 'ml'] }));

      const workers = registry.getAvailable(['gpu', 'ml']);

      expect(workers).toHaveLength(1);
      expect(workers[0].id).toBe('worker-2');
    });

    it('should exclude stale workers', () => {
      // Register workers first
      registry.register(createWorker('worker-1'));
      registry.register(createWorker('worker-2'));

      // Manually set worker-1's heartbeat to stale (after registration)
      const worker1 = registry.get('worker-1');
      if (worker1) {
        worker1.lastHeartbeat = new Date(Date.now() - 60000); // 60 seconds ago
      }

      const available = registry.getAvailable();

      expect(available).toHaveLength(1);
      expect(available[0].id).toBe('worker-2');
    });
  });

  describe('getAll', () => {
    it('should return all workers', () => {
      registry.register(createWorker('worker-1'));
      registry.register(createWorker('worker-2'));
      registry.register(createWorker('worker-3'));

      expect(registry.getAll()).toHaveLength(3);
    });
  });

  describe('pruneStale', () => {
    it('should mark stale workers as offline', () => {
      // Register workers first
      registry.register(createWorker('worker-1'));
      registry.register(createWorker('worker-2'));

      // Manually set worker-1's heartbeat to stale (after registration)
      const worker1 = registry.get('worker-1');
      if (worker1) {
        worker1.lastHeartbeat = new Date(Date.now() - 60000); // 60 seconds ago
      }

      const pruned = registry.pruneStale();

      expect(pruned).toEqual(['worker-1']);
      expect(registry.get('worker-1')?.status).toBe('offline');
      expect(registry.get('worker-2')?.status).toBe('idle');
    });
  });

  describe('clear', () => {
    it('should remove all workers', () => {
      registry.register(createWorker('worker-1'));
      registry.register(createWorker('worker-2'));

      registry.clear();

      expect(registry.size()).toBe(0);
    });
  });
});
