/**
 * Tests for ClickHouse Writer
 */

import {
  ClickHouseWriter,
  SchedulerDecisionRecord,
  getClickHouseWriter,
  resetGlobalClickHouseWriter,
} from './clickhouse';

// Mock @clickhouse/client
jest.mock('@clickhouse/client', () => ({
  createClient: jest.fn(() => ({
    command: jest.fn().mockResolvedValue(undefined),
    insert: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue({
      json: jest.fn().mockResolvedValue([]),
    }),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

describe('ClickHouseWriter', () => {
  let writer: ClickHouseWriter;

  beforeEach(() => {
    jest.clearAllMocks();
    writer = new ClickHouseWriter({
      batchSize: 5,
      flushIntervalMs: 10000,
    });
  });

  afterEach(async () => {
    await writer.disconnect();
  });

  describe('constructor', () => {
    it('should create writer with default config', () => {
      const defaultWriter = new ClickHouseWriter();
      expect(defaultWriter).toBeInstanceOf(ClickHouseWriter);
      expect(defaultWriter.isConnected()).toBe(false);
    });

    it('should create writer with custom config', () => {
      const customWriter = new ClickHouseWriter({
        url: 'http://custom:8123',
        database: 'custom_db',
        tableName: 'custom_table',
      });
      expect(customWriter).toBeInstanceOf(ClickHouseWriter);
    });
  });

  describe('connect', () => {
    it('should connect to ClickHouse', async () => {
      await writer.connect();
      expect(writer.isConnected()).toBe(true);
    });

    it('should be idempotent', async () => {
      await writer.connect();
      await writer.connect();
      expect(writer.isConnected()).toBe(true);
    });
  });

  describe('disconnect', () => {
    it('should disconnect from ClickHouse', async () => {
      await writer.connect();
      await writer.disconnect();
      expect(writer.isConnected()).toBe(false);
    });

    it('should be idempotent', async () => {
      await writer.connect();
      await writer.disconnect();
      await writer.disconnect();
      expect(writer.isConnected()).toBe(false);
    });
  });

  describe('write', () => {
    it('should buffer records', async () => {
      await writer.connect();

      const record: SchedulerDecisionRecord = {
        timestamp: new Date(),
        taskId: 'task-1',
        taskType: 'test',
        workerId: 'worker-1',
        predictedDurationMs: 100,
        predictedWaitMs: 10,
        score: 0.9,
        reasoning: 'prediction',
        fallbackUsed: false,
      };

      writer.write(record);
      expect(writer.getBufferSize()).toBe(1);
    });

    it('should auto-flush when batch size reached', async () => {
      await writer.connect();

      const records: SchedulerDecisionRecord[] = Array.from(
        { length: 5 },
        (_, i) => ({
          timestamp: new Date(),
          taskId: `task-${i}`,
          taskType: 'test',
          workerId: `worker-${i}`,
          predictedDurationMs: 100,
          predictedWaitMs: 10,
          score: 0.9,
          reasoning: 'prediction',
          fallbackUsed: false,
        })
      );

      records.forEach((r) => writer.write(r));

      // Wait for async flush to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Buffer should be cleared after auto-flush
      expect(writer.getBufferSize()).toBe(0);
    });
  });

  describe('flush', () => {
    it('should flush buffered records', async () => {
      await writer.connect();

      const record: SchedulerDecisionRecord = {
        timestamp: new Date(),
        taskId: 'task-1',
        taskType: 'test',
        workerId: 'worker-1',
        predictedDurationMs: 100,
        predictedWaitMs: 10,
        score: 0.9,
        reasoning: 'prediction',
        fallbackUsed: false,
      };

      writer.write(record);
      expect(writer.getBufferSize()).toBe(1);

      await writer.flush();
      expect(writer.getBufferSize()).toBe(0);
    });

    it('should handle empty buffer', async () => {
      await writer.connect();
      await writer.flush();
      expect(writer.getBufferSize()).toBe(0);
    });

    it('should not flush if not connected', async () => {
      const record: SchedulerDecisionRecord = {
        timestamp: new Date(),
        taskId: 'task-1',
        taskType: 'test',
        workerId: 'worker-1',
        predictedDurationMs: 100,
        predictedWaitMs: 10,
        score: 0.9,
        reasoning: 'prediction',
        fallbackUsed: false,
      };

      writer.write(record);
      await writer.flush();
      // Buffer should remain since not connected
      expect(writer.getBufferSize()).toBe(1);
    });
  });

  describe('queryByTaskId', () => {
    it('should query decisions by task ID', async () => {
      await writer.connect();
      const results = await writer.queryByTaskId('task-123');
      expect(Array.isArray(results)).toBe(true);
    });

    it('should throw if not connected', async () => {
      await expect(writer.queryByTaskId('task-123')).rejects.toThrow(
        'ClickHouse client not connected'
      );
    });
  });

  describe('queryByWorkerId', () => {
    it('should query decisions by worker ID', async () => {
      await writer.connect();
      const results = await writer.queryByWorkerId('worker-1', 50);
      expect(Array.isArray(results)).toBe(true);
    });

    it('should throw if not connected', async () => {
      await expect(writer.queryByWorkerId('worker-1')).rejects.toThrow(
        'ClickHouse client not connected'
      );
    });
  });

  describe('queryByTimeRange', () => {
    it('should query decisions by time range', async () => {
      await writer.connect();
      const startTime = new Date(Date.now() - 3600000);
      const endTime = new Date();
      const results = await writer.queryByTimeRange(startTime, endTime);
      expect(Array.isArray(results)).toBe(true);
    });

    it('should throw if not connected', async () => {
      const startTime = new Date(Date.now() - 3600000);
      const endTime = new Date();
      await expect(writer.queryByTimeRange(startTime, endTime)).rejects.toThrow(
        'ClickHouse client not connected'
      );
    });
  });

  describe('getFallbackStats', () => {
    it('should return fallback statistics', async () => {
      await writer.connect();

      // Mock query response for stats
      const { createClient } = require('@clickhouse/client');
      createClient.mockReturnValue({
        command: jest.fn().mockResolvedValue(undefined),
        insert: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue({
          json: jest.fn().mockResolvedValue([
            { total: '100', fallback_count: '20' },
          ]),
        }),
        close: jest.fn().mockResolvedValue(undefined),
      });

      const statsWriter = new ClickHouseWriter();
      await statsWriter.connect();

      const startTime = new Date(Date.now() - 3600000);
      const endTime = new Date();
      const stats = await statsWriter.getFallbackStats(startTime, endTime);

      expect(stats).toHaveProperty('total');
      expect(stats).toHaveProperty('fallback');
      expect(stats).toHaveProperty('ratio');

      await statsWriter.disconnect();
    });
  });

  describe('getBufferSize', () => {
    it('should return current buffer size', () => {
      expect(writer.getBufferSize()).toBe(0);
    });
  });
});

describe('Global ClickHouse Writer', () => {
  afterEach(async () => {
    await resetGlobalClickHouseWriter();
  });

  it('should return singleton instance', () => {
    const writer1 = getClickHouseWriter();
    const writer2 = getClickHouseWriter();
    expect(writer1).toBe(writer2);
  });

  it('should reset global instance', async () => {
    const writer1 = getClickHouseWriter();
    await resetGlobalClickHouseWriter();
    const writer2 = getClickHouseWriter();
    expect(writer1).not.toBe(writer2);
  });
});
