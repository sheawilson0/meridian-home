'use strict';

// Public sources must not turn a redirect or DNS answer into access to this
// Mac, the LAN, the tailnet or a cloud instance's metadata service.
const dns = require('node:dns');
const net = require('node:net');

const PRIVATE = new net.BlockList();
for (const [address, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 3],
]) PRIVATE.addSubnet(address, bits, 'ipv4');
for (const [address, bits] of [
  ['::', 96], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['2001::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) PRIVATE.addSubnet(address, bits, 'ipv6');

function publicAddress(address) {
  const family = net.isIP(address);
  return Boolean(family && !PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6'));
}

const refused = () => Object.assign(new Error('public source resolved to a private address'), { code: 'ERR_PRIVATE_ADDRESS' });

// Node skips lookup for IP literals, so check those before creating a request.
function checkPublicUrl(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !publicAddress(host)) throw refused();
}

function publicLookup(host, options, callback) {
  dns.lookup(host, { all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) return callback(refused());
    // Supply the checked answer itself, including when Node asks for all
    // addresses. No second resolution between the check and connection.
    const family = typeof options === 'number' ? options : options && options.family;
    const pinned = addresses.find((answer) => !family || answer.family === family);
    if (options && options.all) callback(null, addresses);
    else if (pinned) callback(null, pinned.address, pinned.family);
    else callback(refused());
  });
}

module.exports = { publicAddress, checkPublicUrl, publicLookup };
