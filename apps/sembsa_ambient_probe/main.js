'use strict';
/**
 * Ambient Probe - read-only. Three views (Mode button):
 *  - List: interfaces in the head unit's SOME/IP catalog (/etc/oap/someip/someip-interfaces.json) about
 *    ambient / interior light, with get / notify / set flags.
 *  - Details: the ambient fields of 0xB512 and 0xB09E with their full data types (every struct member,
 *    every enum value), wrapped, never cut.
 *  - Live log: the car's notifications of the status fields in LIVE, with a time stamp, kept in
 *    data/live.log. Only subscribes and reads: nothing is written to the car.
 * The full result also goes to the app's log. Without a readable catalog (the emulator) the Demo setting
 * shows a made-up one and made-up notifications, marked DEMO.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');

const CATALOG = '/etc/oap/someip/someip-interfaces.json';
const SVC = 0xb512;
const NAME_RE = /comfort|ambient|light|iuk|interior/i;
const DETAIL = [
    [0xb512, ['ambientLightInteriorColour', 'ambientLightInteriorUserSetting', 'statusAmbientLightInteriorColour',
        'statusAmbientLightInteriorUserSetting', 'statusALEV4']],
    [0xb09e, ['currentInteriorLightProfile', 'brightnessAmbientLight']],
];
// subscribed in Live log; each must be in app.json "signals" with "rs" (only read flags: nothing is written)
const LIVE = [
    { iface: 'de.bmw.infotainment.misc.ComfortFunctionIuK', inst: '1', field: 'statusAmbientLightInteriorColour', key: 'colour' },
    { iface: 'de.bmw.body.interiorillumination.AmbientLight', inst: '1', field: 'currentInteriorLightProfile', key: 'profile' },
    { iface: 'de.bmw.body.interiorillumination.AmbientLight', inst: '1', field: 'brightnessAmbientLight', key: 'brightness' },
];
const WRAP = 118, ROWS = 11, LOG_KEEP = 400;

// made up for the emulator only: the shape of the real catalog (kit/tools/sigdoc.py), not its content
const DEMO = {
    interfaces: {
        'de.bmw.infotainment.misc.ComfortFunctionIuK (DEMO)': { serviceId: SVC,
            fields: { statusAmbientLightInteriorColour: { getter: 3, notifier: 32771, dataRef: 'AmbientColour' },
                ambientLightInteriorColour: { setter: 26, dataRef: 'AmbientColour' } },
            methods: { requestAmbientPreview: {} } },
        'de.bmw.body.interiorillumination.AmbientLight (DEMO)': { serviceId: 0xb09e,
            fields: { currentInteriorLightProfile: { getter: 1, notifier: 32769, dataRef: 'Profile' } } },
    },
    datatypes: {
        AmbientColour: { type: 'struct', members: [{ name: 'hue', dataRef: 'UInt16' }, { name: 'colour', dataRef: 'UInt8' },
            { name: 'layer', dataRef: 'Layer' }, { name: 'brightness', dataRef: 'UInt8' }] },
        Layer: { type: 'enum', items: { LAYER_1: 1, LAYER_2: 2, LAYER_3: 3 } },
        Profile: { type: 'enum', items: { COLOUR1: 1, COLOUR2: 2, COLOUR3: 3, COLOUR4: 4, COLOUR5: 5, COLOUR6: 6, COLOUR7: 7, COLOUR8: 8, COLOUR9: 9, COLOUR10: 10, COLOUR11: 11 } },
    },
};

/** a data type in words, short (List view) */
function typ(db, ref, depth) {
    const d = (db.datatypes || {})[ref];
    if (!d) return String(ref);
    if (d.type === 'struct') {
        if (depth > 1) return 'struct';
        return '{' + members(db, d).map((m) => m.name + ':' + typ(db, m.dataRef, depth + 1)).join(', ') + '}';
    }
    if (d.type === 'enum') return 'enum(' + Object.keys(d.items || {}).slice(0, 6).join(',') + ')';
    if (d.type === 'typedef') return typ(db, d.dataRef || d.baseType, depth);
    if (d.type === 'array') return '[' + typ(db, d.elementDataRef, depth + 1) + ']';
    return d.type;
}

function members(db, d) {
    let mem = [], dd = d;
    for (;;) { mem = (dd.members || []).concat(mem); if (!dd.extends || !db.datatypes[dd.extends]) break; dd = db.datatypes[dd.extends]; }
    return mem;
}

/** a data type in full, one line per member, every enum value (Details view) */
function typeLines(db, ref, ind, seen) {
    const d = (db.datatypes || {})[ref], pad = '  '.repeat(ind);
    if (!d) return [pad + 'type ' + ref];
    if (seen.includes(ref)) return [pad + ref + ' (see above)'];
    seen = seen.concat(ref);
    if (d.type === 'struct') {
        const out = [pad + ref + ': struct'];
        for (const m of members(db, d)) {
            const sub = typeLines(db, m.dataRef, ind + 2, seen);
            out.push(pad + '  .' + m.name + ' : ' + sub[0].trim());
            out.push(...sub.slice(1));
        }
        return out;
    }
    if (d.type === 'enum') {
        const items = Object.entries(d.items || {}).map(([k, v]) => k + '=' + v);
        return [pad + ref + ': enum (' + items.length + ')', pad + '  ' + items.join(', ')];
    }
    if (d.type === 'typedef') return [pad + ref + ' = ' + typeLines(db, d.dataRef || d.baseType, ind, seen).join(' ').trim()];
    if (d.type === 'array') return [pad + ref + ': array of'].concat(typeLines(db, d.elementDataRef, ind + 1, seen));
    return [pad + ref + ': ' + d.type + Object.entries(d).filter(([k]) => k !== 'type').map(([k, v]) => ' ' + k + '=' + JSON.stringify(v)).join('')];
}

/** cuts a line into pieces of at most n characters, at spaces when it can; nothing is dropped */
function wrap(s, n) {
    const ind = (/^ */.exec(s) || [''])[0] + '    ', out = [];
    let rest = s;
    while (rest.length > n) {
        let k = rest.lastIndexOf(' ', n);
        if (k <= ind.length) k = n;
        out.push(rest.slice(0, k));
        rest = ind + rest.slice(k).replace(/^ +/, '');
    }
    out.push(rest);
    return out;
}

const svcNum = (v) => (typeof v === 'string' ? parseInt(v, v.startsWith('0x') ? 16 : 10) : v);
const hex = (n) => '0x' + (n >>> 0).toString(16).toUpperCase();

/** the interfaces worth a look, 0xB512 first, as lines to show */
function probe(db) {
    const hits = Object.keys(db.interfaces || {}).filter((n) => svcNum(db.interfaces[n].serviceId) === SVC || NAME_RE.test(n))
        .sort((a, b) => (svcNum(db.interfaces[b].serviceId) === SVC) - (svcNum(db.interfaces[a].serviceId) === SVC));
    const lines = [];
    for (const n of hits) {
        const i = db.interfaces[n], svc = svcNum(i.serviceId);
        lines.push({ head: true, hit: svc === SVC, text: n + '   svc 0x' + (svc >>> 0).toString(16) + (svc === SVC ? '   <- 0xB512' : '') });
        for (const [f, fd] of Object.entries(i.fields || {})) {
            const flags = [fd.getter && 'get', fd.notifier && 'notify', fd.setter && 'SET'].filter(Boolean).join('/') || '-';
            lines.push({ text: '  ' + f + '  [' + flags + ']  ' + typ(db, fd.dataRef, 0).slice(0, 110) });
        }
        for (const m of Object.keys(i.methods || {})) lines.push({ text: '  method ' + m });
    }
    return { count: hits.length, found: hits.some((n) => svcNum(db.interfaces[n].serviceId) === SVC), lines };
}

/** the DETAIL fields with their full types, wrapped, as lines to show */
function details(db) {
    const lines = [];
    for (const [s, fields] of DETAIL) {
        const names = Object.keys(db.interfaces || {}).filter((n) => svcNum(db.interfaces[n].serviceId) === s);
        if (!names.length) { lines.push({ head: true, text: hex(s) + ': not in the catalog' }); continue; }
        for (const n of names) {
            const i = db.interfaces[n];
            lines.push({ head: true, hit: true, text: hex(s) + '  ' + n });
            for (const f of fields) {
                const fd = (i.fields || {})[f];
                if (!fd) { lines.push({ head: true, text: '  ' + f + ': not in this interface' }); continue; }
                const ids = ['getter', 'notifier', 'setter'].filter((k) => fd[k] != null).map((k) => k + ' ' + fd[k]).join(', ') || 'no getter / notifier / setter';
                lines.push({ head: true, text: '  ' + f + '   (' + ids + ')' });
                typeLines(db, fd.dataRef, 2, []).forEach((l) => wrap(l, WRAP).forEach((w) => lines.push({ text: w })));
            }
        }
    }
    return lines;
}

/** one notification as log lines: time, field, the profile last seen, the value in full */
function liveLines(e) {
    const head = e.time + '  ' + e.field + (e.key === 'colour' ? '   profile ' + (e.profile == null ? '?' : e.profile) : '');
    return [{ head: true, text: head }].concat(wrap('    ' + JSON.stringify(e.value), WRAP).map((t) => ({ text: t })));
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        let db = null, err = '';
        try { db = JSON.parse(fs.readFileSync(CATALOG, 'utf8')); } catch (e) { err = e.code || String(e); }
        const demo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !db);
        const cat = () => (demo() ? DEMO : db || {});
        if (db) {
            const r = probe(db);
            log.info('catalog: ' + Object.keys(db.interfaces || {}).length + ' interfaces, ' + r.count + ' match, 0xB512 ' + (r.found ? 'FOUND' : 'not there'));
            r.lines.forEach((l) => log.info(l.text));
            details(db).forEach((l) => log.info('detail ' + l.text));
        } else log.warn('catalog ' + CATALOG + ' not readable: ' + err);

        // live log: newest first, also appended to data/live.log
        const events = [], subs = {};
        let profile = null;
        const logFile = path.join(ctx.dataDir || '.', 'live.log');
        const record = (l, value, fake) => {
            if (l.key === 'profile') profile = JSON.stringify(value);
            const e = { time: new Date().toISOString().replace('T', ' ').slice(0, 19), field: l.field, key: l.key, profile, value, fake: !!fake };
            events.unshift(e);
            events.length = Math.min(events.length, LOG_KEEP);
            const line = e.time + '\t' + e.field + '\tprofile=' + e.profile + '\t' + JSON.stringify(value) + (fake ? '\tDEMO' : '');
            log.info('live ' + line);
            if (!fake) fs.appendFile(logFile, line + '\n', () => {});
            if (mode === 2) kick();
        };
        for (const l of LIVE) {
            ctx.signals.watch(l.iface, l.inst, { [l.field]: (v) => record(l, v) }, log)
                .then((s) => { subs[l.field] = s.error ? 'error: ' + s.error : 'subscribed'; log.info('live ' + l.field + ': ' + subs[l.field]); })
                .catch((e) => { subs[l.field] = 'error: ' + e; });
        }
        let tick = 0;
        setInterval(() => { // made-up notifications for the emulator only
            if (!demo() || mode !== 2) return;
            tick++;
            const l = LIVE[tick % LIVE.length];
            record(l, l.key === 'profile' ? { currentLightProfileId: 'COLOUR' + (tick % 14 + 1) } : l.key === 'brightness' ? tick * 7 % 100
                : { controlHueInteriorLighting: (tick * 2731) % 65536 }, true);
        }, 3000);

        const MODES = ['List', 'Details', 'Live log'];
        let mode = 0, page = 0, loop = null;
        const kick = () => (loop && loop.kick ? loop.kick() : render());
        const render = async () => {
            const t = ctx.theme(), c = cat();
            const lines = mode === 0 ? probe(c).lines : mode === 1 ? details(c)
                : [].concat(...events.filter((e) => e.fake === demo()).map(liveLines));
            const pages = Math.max(1, Math.ceil(lines.length / ROWS));
            page %= pages;
            const cv = ctx.canvas(1600, 520).clear(t.bg);
            G.frame(cv, t, ['Ambient light'], 0, [demo() && { text: 'DEMO' }]);
            let status;
            if (!db && !demo()) status = 'Catalog not readable (' + err + ')';
            else if (mode === 0) { const r = probe(c); status = r.found ? 'Ambient light service 0xB512 found' : r.count ? 'No 0xB512 - similar interfaces below' : 'Nothing about ambient light in the catalog'; }
            else if (mode === 1) status = 'Details: 0xB512 and 0xB09E ambient fields';
            else status = 'Live log (UTC): ' + LIVE.map((l) => l.key + ' ' + (demo() ? 'DEMO' : subs[l.field] || '...')).join(', ');
            cv.text(status.slice(0, 90), 40, 110, 30, t.accent2, { font: 'bold' });
            cv.text(MODES[mode] + ' - read only: nothing is written to the car.  Page ' + (page + 1) + '/' + pages +
                (mode === 2 ? '  (' + events.length + ' saved in data/live.log, newest first)' : ''), 40, 150, 22, t.dim);
            if (mode === 2 && !lines.length) cv.text('Waiting for a change: switch the ambient colour in the car settings.', 40, 210, 24, t.text);
            lines.slice(page * ROWS, page * ROWS + ROWS).forEach((l, k) =>
                cv.text(l.text, 40, 195 + k * 30, l.head ? 23 : 21, l.hit ? t.accent2 : l.head ? t.text : t.dim, l.head ? { font: 'bold' } : {}));
            return ui.image('MAIN_GFX', cv);
        };
        loop = ctx.loop('MAIN', 5, render);
        ui.onClick('BTN_NEXT', () => { page++; return kick(); });
        ui.onClick('BTN_MODE', () => { mode = (mode + 1) % MODES.length; page = 0; return kick(); });
        settings.onChange(() => render());
        await render();
    },
});

// self-check: node main.js --test
if (process.argv.includes('--test')) {
    const assert = require('assert');
    const r = probe(DEMO);
    assert.strictEqual(r.found, true);
    assert.strictEqual(r.count, 2);
    assert.ok(r.lines[0].hit && r.lines[1].text.includes('[get/notify]') && r.lines[1].text.includes('hue:UInt16'));
    assert.strictEqual(probe({ interfaces: { 'x.Radio': { serviceId: '0x10' } } }).count, 0);
    const d = details(DEMO).map((l) => l.text).join('\n');
    assert.ok(d.includes('COLOUR11=11') && d.includes('COLOUR1=1'), 'every enum value');
    assert.ok(d.includes('.layer : Layer: enum (3)') && d.includes('LAYER_3=3'), 'nested enum in a struct');
    assert.ok(d.includes('ambientLightInteriorUserSetting: not in this interface'));
    assert.ok(details(DEMO).every((l) => l.text.length <= WRAP), 'wrapped');
    const long = 'x '.repeat(200) + 'END';
    assert.strictEqual(wrap(long, 50).map((s) => s.trim()).join(' ').replace(/ +/g, ' '), long.replace(/ +/g, ' '), 'wrap keeps all text');
    assert.ok(wrap('y'.repeat(300), 50).every((s) => s.length <= 50));
    console.log('ok');
}
