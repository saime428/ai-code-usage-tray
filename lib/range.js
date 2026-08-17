'use strict';

const MAX_RANGE_DAYS = 90;

function dayKey(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function normalizeRangeDays(value, fallback = 1) {
  const days = Number(value);
  return Number.isInteger(days) && days >= 1 && days <= MAX_RANGE_DAYS ? days : fallback;
}

function rangeBounds(now = new Date(), value = 1) {
  const rangeDays = normalizeRangeDays(value, null);
  if (!rangeDays) throw new RangeError(`rangeDays must be an integer from 1 to ${MAX_RANGE_DAYS}`);
  const end = now.getTime();
  const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  startDate.setDate(startDate.getDate() - rangeDays + 1);
  return {
    rangeDays,
    rangeStart: startDate.getTime(),
    rangeEnd: end,
    startDay: dayKey(startDate),
    endDay: dayKey(now),
    date: rangeDays === 1 ? dayKey(now) : `${dayKey(startDate)} - ${dayKey(now)}`,
  };
}

module.exports = { MAX_RANGE_DAYS, dayKey, normalizeRangeDays, rangeBounds };
