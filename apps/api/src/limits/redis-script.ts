/** Standalone Redis only: atomic reservation, Redis-time windows, no identifiers. */
export const RESERVE_LUA = `
local mode = ARGV[1]
local hourLimit = tonumber(ARGV[2])
local dayLimit = tonumber(ARGV[3])
if (mode ~= 'attempt' and mode ~= 'subcall') or
   not hourLimit or hourLimit < 1 or hourLimit > 10000 or hourLimit % 1 ~= 0 or
   not dayLimit or dayLimit < 1 or dayLimit > 1000000 or dayLimit % 1 ~= 0 then
  return redis.error_reply('INVALID_BUDGET_ARGUMENTS')
end
local now = tonumber(redis.call('TIME')[1])
local hour = math.floor(now / 3600)
local day = math.floor(now / 86400)
local hourEnd = (hour + 1) * 3600
local dayEnd = (day + 1) * 86400

local function readState(key, window, fields, maximum)
  local values = redis.call('HMGET', key, unpack(fields))
  local result = {}
  local present = 0
  for i, value in ipairs(values) do
    if value then
      present = present + 1
      result[i] = tonumber(value)
      if not result[i] or result[i] % 1 ~= 0 or result[i] < 0 then return nil end
    else result[i] = 0 end
  end
  if present ~= 0 and present ~= #fields then return nil end
  if result[1] > window then return nil end
  for i = 2, #fields do if result[i] > maximum then return nil end end
  if result[1] ~= window then
    result[1] = window
    for i = 2, #fields do result[i] = 0 end
  end
  return result
end

local h = readState(KEYS[1], hour, {'window', 'count'}, 10000)
local d = readState(KEYS[2], day, {'window', 'attempts', 'subcalls'}, 1000000)
if not h or not d or d[2] + d[3] > 1000000 then
  return redis.error_reply('INVALID_BUDGET_STATE')
end
if mode == 'attempt' then
  if h[2] >= hourLimit then
    redis.call('HSET', KEYS[1], 'window', hour, 'count', hourLimit)
    redis.call('EXPIREAT', KEYS[1], hourEnd + 60)
    return {1, hourEnd - now}
  end
  redis.call('HSET', KEYS[1], 'window', hour, 'count', h[2] + 1)
  redis.call('EXPIREAT', KEYS[1], hourEnd + 60)
end
if d[2] + d[3] >= dayLimit then return {2, dayEnd - now} end
if mode == 'attempt' then d[2] = d[2] + 1 else d[3] = d[3] + 1 end
redis.call('HSET', KEYS[2], 'window', day, 'attempts', d[2], 'subcalls', d[3])
redis.call('EXPIREAT', KEYS[2], dayEnd + 60)
return {0, 0}
`;
