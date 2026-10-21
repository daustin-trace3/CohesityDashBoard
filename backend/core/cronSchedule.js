const nodeCron = require('node-cron');

// node-cron 3 drops a tick whose :00 second passed while the event loop was
// busy unless recoverMissedExecutions is on, and with it on it can fire the
// same tick twice (its last-run mark is truncated to the second). Recover
// missed ticks, but run each minute at most once.
function scheduleCron(expression, fn, cronLib = nodeCron) {
  let lastMinute = null;
  return cronLib.schedule(expression, (now) => {
    if (now instanceof Date) {
      const minute = Math.floor(now.getTime() / 60000);
      if (minute === lastMinute) return undefined;
      lastMinute = minute;
    }
    return fn(now);
  }, { recoverMissedExecutions: true });
}

module.exports = { scheduleCron };
