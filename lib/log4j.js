'use strict';
// Minecraft writes its log as log4j XML events. This turns them back into the
// familiar "[12:00:00] [Render thread/INFO]: message" lines, line by line.

const HARMLESS = /Realms|SignedJWT|Failed to verify authentication|Failed to retrieve profile key pair|Failed to fetch user properties|Could not authorize|Status code 40[13]|Unable to (?:fetch|get) (?:player|profile)|multiplayer is disabled|Invalid session/i;
const ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' };
const unent = (s) => s.replace(/&(?:lt|gt|quot|apos|amp);/g, (m) => ENTITIES[m]);

function cdata(block, tag) {
  const m = new RegExp('<log4j:' + tag + '>([\\s\\S]*?)</log4j:' + tag + '>').exec(block);
  if (!m) return '';
  let t = m[1];
  t = t.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return unent(t);
}

function two(n) { return String(n).padStart(2, '0'); }

function convert(block) {
  const head = /<log4j:Event\b([^>]*)>/.exec(block);
  if (!head) return null;
  const attr = (n) => { const m = new RegExp('\\b' + n + '="([^"]*)"').exec(head[1]); return m ? unent(m[1]) : ''; };
  const ts = Number(attr('timestamp'));
  const d = Number.isFinite(ts) && ts > 0 ? new Date(ts) : new Date();
  const time = two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
  let level = attr('level') || 'INFO';
  const thread = attr('thread') || 'main';
  const msg = cdata(block, 'Message');
  const thr = cdata(block, 'Throwable');
  if ((level === 'ERROR' || level === 'WARN') && HARMLESS.test(msg + '\n' + thr)) {
    return ['[' + time + '] [' + thread + '/WARN]: ' + (msg.split('\n')[0] || 'Online service unavailable') + '  (harmless in offline mode)'];
  }
  const out = [];
  const msgLines = msg.split('\n');
  out.push('[' + time + '] [' + thread + '/' + level + ']: ' + msgLines[0]);
  for (const l of msgLines.slice(1)) out.push(l);
  if (thr) for (const l of thr.split('\n')) out.push(l);
  return out;
}

function createXmlFilter() {
  let buf = null;
  return {
    push(line) {
      if (buf === null) {
        if (!/^\s*<log4j:Event\b/.test(line)) return [line];
        buf = [];
      }
      buf.push(line);
      if (/<\/log4j:Event>/.test(line)) {
        const block = buf.join('\n');
        buf = null;
        return convert(block) || [block];
      }
      if (buf.length > 400) { const raw = buf; buf = null; return raw; }   // runaway event: show it raw
      return [];
    },
    flush() {
      if (!buf) return [];
      const raw = buf; buf = null; return raw;
    }
  };
}

module.exports = { createXmlFilter };
