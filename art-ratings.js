'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

const VALID_RATINGS = new Set(['like', 'dislike']);

function emptyRatings() {
  return { version: 1, updatedAt: null, ratings: {} };
}

function artworkImage(art) {
  return `https://www.artic.edu/iiif/2/${art.i}/full/1600,/0/default.jpg`;
}

function artworkDescription(art) {
  return `A textured oil painting by ${art.a}${art.d ? `, painted in ${art.d}` : ''}.`;
}

function createStore(file, artworks = []) {
  const byId = new Map(artworks.map((art) => [art.i, art]));
  let pending = Promise.resolve();

  async function read() {
    let saved;
    try {
      saved = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return emptyRatings();
      if (error instanceof SyntaxError) return emptyRatings();
      throw error;
    }

    const ratings = {};
    const storedRatings = saved && typeof saved === 'object' && saved.ratings && typeof saved.ratings === 'object'
      ? saved.ratings : {};
    for (const [artId, value] of Object.entries(storedRatings)) {
      const art = byId.get(artId);
      if (!art || !value || !VALID_RATINGS.has(value.rating)) continue;
      ratings[artId] = {
        rating: value.rating,
        id: art.id,
        title: art.t,
        artist: art.a,
        year: art.d,
        image: artworkImage(art),
        description: artworkDescription(art),
        source: art.source,
        ratedAt: typeof value.ratedAt === 'string' ? value.ratedAt : null,
      };
    }
    return {
      version: 1,
      updatedAt: saved && typeof saved.updatedAt === 'string' ? saved.updatedAt : null,
      order: Array.isArray(saved.order) ? saved.order.filter(id => ratings[id]?.rating === 'like') : [],
      ratings,
    };
  }

  async function write(data) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temp = file + '.tmp';
    await fsp.writeFile(temp, JSON.stringify(data, null, 2) + '\n');
    await fsp.rename(temp, file);
  }

  function set(artId, rating) {
    const operation = pending.then(async () => {
      const art = byId.get(artId);
      if (!art) throw new Error('unknown artwork');
      if (rating !== null && !VALID_RATINGS.has(rating)) throw new Error('bad rating');

      const saved = await read();
      if (rating === null) {
        delete saved.ratings[artId];
      } else {
        saved.ratings[artId] = {
          rating,
          id: art.id,
          title: art.t,
          artist: art.a,
          year: art.d,
          image: artworkImage(art),
          description: artworkDescription(art),
          source: art.source,
          ratedAt: new Date().toISOString(),
        };
      }
      // A newly saved work goes to the front of the collection; anything no
      // longer saved leaves the manual order.
      const order = (saved.order || []).filter((id) => id !== artId);
      if (rating === 'like') order.unshift(artId);
      saved.order = order;
      saved.updatedAt = new Date().toISOString();
      await write(saved);
      return saved.ratings[artId] || null;
    });
    pending = operation.catch(() => {});
    return operation;
  }

  function reorder(order) {
    const operation = pending.then(async () => {
      const saved = await read();
      if (!Array.isArray(order) || order.length > byId.size || new Set(order).size !== order.length || order.some(id => saved.ratings[id]?.rating !== 'like')) throw new Error('Invalid artwork order');
      saved.order = order;
      saved.updatedAt = new Date().toISOString();
      await write(saved);
      return saved.order;
    });
    pending = operation.catch(() => {});
    return operation;
  }
  return { read, set, reorder };
}

module.exports = { createStore, VALID_RATINGS };
