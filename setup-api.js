'use strict';

const runtime = require('./runtime');
const firstRun = require('./first-run');
const schema = require('./setup-schema');

function createSetup({ config, file, queue, calendarUrl, onChange = () => {} }) {
  function status() {
    const setup = runtime.setup();
    return { ...setup, connectors: Object.fromEntries(Object.entries(setup.connectors).map(([name, value]) => [name, {
      ...value, reason: !value.configured && ['disabled', 'missing configuration or tool'].includes(value.reason) ? schema.SCHEMA[name].reason || value.reason : value.reason,
      ...schema.fields(name),
    }])) };
  }

  async function update(name, input) {
    schema.fields(name);
    return queue(file, async () => {
      const current = firstRun.connectorStatus(config);
      const { enabled, patch } = schema.validate(name, input, config, {
        calendarConfigured: current.calendar.configured, calendarUrl,
        savedCalendar: firstRun.savedFeeds(),
      });
      const next = JSON.parse(JSON.stringify(config));
      const section = name === 'almanac' ? 'place' : name;
      if (Object.keys(patch).length) next[section] = { ...(next[section] || {}), ...patch };
      if (name === 'calendar' && Object.hasOwn(patch, 'icsUrls')) next.calendar.icsUrl = '';
      if (name === 'notify') next.notify.enabled = enabled;
      next.connectors[name] = { enabled };
      // Publish the new profile only after both private files have been saved.
      firstRun.save(file, next);
      Object.assign(config, next);
      runtime.updateConnectors(firstRun.connectorStatus(config), config.place);
      await onChange(name);
      const connector = status().connectors[name];
      return { ...connector, ...(!connector.live ? { needsRestart: true } : {}) };
    });
  }

  return { status, update };
}

module.exports = { createSetup };
