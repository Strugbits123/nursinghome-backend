import { Redis } from 'ioredis';

// ... (Existing Configuration and Client Initialization) ...
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined; 
const REDIS_DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days (for facility details)

const redisClient = new Redis({ /* ... your config ... */ });
redisClient.on('connect', () => { console.log('Redis client connected successfully!'); });
redisClient.on('error', (err) => { console.error('Redis Client Error:', err); });


// Utility function to set cache, accepting an optional TTL
export const setCache = (
    key: string, 
    value: string | Buffer | number, 
    ttlSeconds: number = REDIS_DEFAULT_TTL_SECONDS // Default to 30 days
) => {
  return redisClient.setex(key, ttlSeconds, value);
};

// Utility function to get cache
export const getCache = (key: string) => {
  return redisClient.get(key);
};

export default redisClient;