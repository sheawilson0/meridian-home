'use strict';

// A portable profile has no place until all four values are supplied.
function validatePlace(place) {
  if (place === undefined || place === null) return null;
  if (typeof place !== 'object' || Array.isArray(place)) throw new Error('place must be an object');
  if (Object.keys(place).some(key => !['name', 'latitude', 'longitude', 'timezone'].includes(key))) throw new Error('Unknown place field');
  const clean = {};
  for (const key of ['name', 'latitude', 'longitude', 'timezone']) {
    const value = place[key];
    if (key === 'latitude' || key === 'longitude') {
      const limit = key === 'latitude' ? 90 : 180;
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > limit) throw new Error(`${key} must be a number between ${-limit} and ${limit}`);
      clean[key] = value;
    } else {
      if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${key} is required`);
      clean[key] = value.trim();
      if (key === 'timezone') {
        try {
          if (/^[+-]/.test(clean[key])) throw new Error('offset');
          new Intl.DateTimeFormat('en-GB', { timeZone: clean[key] });
        } catch { throw new Error('timezone must be an IANA timezone'); }
      }
    }
  }
  return clean;
}

module.exports = { validatePlace };
