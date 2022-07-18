#!/usr/bin/env node

/**
 * This is a sample HTTP server.
 * Replace this with your implementation.
 */

import dayjs from 'dayjs'
import 'dotenv/config'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { Config } from './config.js'
import utc from 'dayjs/plugin/utc'
import { createClient, RedisClientType } from 'redis'

dayjs.extend(utc)

const nodePath = resolve(process.argv[1])
const modulePath = resolve(fileURLToPath(import.meta.url))
const isCLI = nodePath === modulePath

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function setUpRedisClient() {
  const client = createClient()

  client.on('error', err => {
    // eslint-disable-next-line no-console
    console.error('Redis Client Error', err)
  })

  await client.connect()

  return client
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function RateLimitUsingFixedWindow(
  client: RedisClientType,
  userID: string,
  intervalInSeconds: number,
  maximumRequests = 100,
) {
  const currentTime = dayjs().utc()
  currentTime.set('second', 0)
  const currentWindow = currentTime.unix()

  const key = `${userID}:${currentWindow}`

  const value = await client.get(key)

  if (value && +value >= maximumRequests) {
    return false
  }

  const exist = await client.exists(key)

  exist
    ? await client.incr(key)
    : await client.set(key, 0, {
        EX: intervalInSeconds * 2, // expiry in double the interval time
      })

  return true
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function RateLimitUsingLeakyBucket(
  client: RedisClientType,
  userID: string,
  uniqueRequestID: string,
  maximumRequests = 100,
) {
  const key = userID
  const count = await client.lLen(key)

  if (count >= maximumRequests) {
    return false
  }

  await Promise.all([client.rPop(key), client.rPush(key, uniqueRequestID)])

  return false
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function RateLimitUsingSlidingLogs(
  client: RedisClientType,
  userID: string,
  uniqueRequestID: string,
  intervalInSeconds: number,
  maximumRequests: number,
) {
  const currentTime = dayjs().utc().unix()
  const lastWindowTime = currentTime - intervalInSeconds
  const key = userID

  // get count in sorted set from lastWindowTime to currentTime
  const requestCount = await client.zCount(key, lastWindowTime, currentTime)

  if (requestCount >= maximumRequests) {
    const requestCountFromStart = await client.zCount(key, lastWindowTime, currentTime)

    // rempve old logs
    if (requestCountFromStart > maximumRequests * 100) {
      await client.zRemRangeByScore(key, -Infinity, lastWindowTime)
    }

    return false
  }

  await client.zAdd(key, {
    score: currentTime,
    value: uniqueRequestID,
  })

  return true
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function RateLimitUsingSlidingWindow(
  client: RedisClientType,
  userID: string,
  intervalInSeconds: number,
  maximumRequests: number,
) {
  const currentTime = dayjs.utc()
  currentTime.set('seconds', 0)
  const currentWindow = currentTime.unix()

  const keyCurrentWindow = `${userID}:${currentWindow}`

  const currentWindowValue = await client.get(keyCurrentWindow)
  const currentWindowCount = currentWindowValue === null ? 0 : +currentWindowValue

  if (currentWindowCount >= maximumRequests) {
    return false
  }

  const lastWindow = currentTime.unix() - intervalInSeconds

  const keyLastWindow = `${userID}:${lastWindow}`

  const lastWindowValue = await client.get(keyLastWindow)
  const lastWindowCount = lastWindowValue === null ? 0 : +lastWindowValue

  const elapsedTimePercentage = Math.trunc((currentWindow % intervalInSeconds) / intervalInSeconds)
  // Requests in current window + requests in the previous window * overlap percentage ofthe rolling window and previous window
  if (lastWindowCount * (1 - elapsedTimePercentage) + currentWindowCount) {
    return false
  }

  const exist = await client.exists(keyCurrentWindow)

  exist
    ? await client.incr(keyCurrentWindow)
    : await client.set(keyCurrentWindow, 0, {
        EX: intervalInSeconds * 5, // expiry in double the interval time
      })

  return true
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function RateLimitUsingTokenBucket(
  client: RedisClientType,
  userID: string,
  intervalInSeconds: number,
  maximumRequests: number,
) {
  const keyResetTime = `${userID}:last_reset_time`
  const keyCount = `${userID}:count`

  const lastRestTimeValue = await client.get(keyResetTime)
  const lastRestTimeCount = lastRestTimeValue === null ? 0 : +lastRestTimeValue

  // if the key is not available, i.e., this is the first request, lastResetTime will be set to 0 and counter be set to max requests allowed
  // check if time window since last counter reset has elapsed

  if (dayjs().utc().unix() - lastRestTimeCount >= intervalInSeconds) {
    await client.set(keyCount, maximumRequests)
    await client.set(keyResetTime, dayjs().utc().unix())
  } else {
    const countValue = await client.get(keyCount)
    const count = countValue === null ? 0 : +countValue

    if (count <= 0) {
      return false
    }
  }

  await client.decr(keyCount)

  return true
}

export default async function main(port: number = Config.port) {
  const requestListener = (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader('content-type', 'text/plain;charset=utf8')
    response.writeHead(200, 'OK')
    response.end('Olá, Hola, Hello!')
  }

  const server = createServer(requestListener)

  if (isCLI) {
    server.listen(port)
    // eslint-disable-next-line no-console
    console.log(`Listening on port: ${port}`)
  }

  return server
}

if (isCLI) {
  main()
}
