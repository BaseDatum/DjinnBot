import { Redis } from 'ioredis';
import type { RuntimeConfig } from '../config.js';

export type RedisClient = InstanceType<typeof Redis>;

export function createRedisClient(config: RuntimeConfig): RedisClient {
  return new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });
}

export function createSubscriber(config: RuntimeConfig): RedisClient {
  return new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: null, // Subscribers need unlimited retries
  });
}