'use strict';
/**
 * Ambient Probe - read-only. Opens the head unit's SOME/IP catalog (/etc/oap/someip/someip-interfaces.json),
 * finds the ambient light service (ComfortFunctionIuK, service 0xB512 on iDrive 8; any interface whose name
 * says comfort / ambient / light / IuK) and shows its fields (get / notify / set flags, data type) and methods.
 * Nothing is sent to the car. The full result also goes to the log (Store's Phone access shows it).
 * Without a readable catalog (the emulator) the Demo setting shows a made-up one, marked DEMO.
 */
const fs = require('fs');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');

const CATALOG = '/etc/oap/someip/someip-interfaces.json';
const SVC = 0xb512;
const NAME_RE = /comfort|ambient|light|iuk|interior/i;

// made up for the emulator only: the shape of the real catalog (kit/tools/sigdoc.py), not its content
const DEMO = {
    interfaces: {
        'de.bmw.infotainment.vehicle.ComfortFunctionIuK (DEMO)': { serviceId: SVC,
            fields: { statusAmbientLight: { getter: 3, notifier: 32771, setter: 26, dataRef: 'AmbientLight' } },
            methods: { requestAmbientPreview: {} } },
        'de.bmw.infotainment.vehicle.InteriorLight (DEMO)': { serviceId: 0xb5a0,
            fields: { statusReadingLight: { getter: 1, notifier: 0, dataRef: 'OnOff' } } },
    },
    datatypes: {
        AmbientLight: { type: 'struct', members: [{ name: 'hue', dataRef: 'UInt16' }, { name: 'colour', dataRef: 'UInt8' },
            { name: 'layer', dataRef: 'UInt8' }, { name: 'brightness', dataRef: 'UInt8' }, { name: 'mode', dataRef: 'UInt8' }] },
        OnOff: { type: 'enum', items: { OFF: 0, ON: 1 } },
    },
};

/** a data type in words, as sigdoc.py prints it */
function typ(db, ref, depth) {
    const d = (db.datatypes || {})[ref];
    if (!d) return String(ref);
    if (d.type === 'struct') {
        if (depth > 1) return 'struct';
        let mem = [], dd = d;
        for (;;) { mem = (dd.members || []).concat(mem); if (!dd.extends || !db.datatypes[dd.extends]) break; dd = db.datatypes[dd.extends]; }
        return '{' + mem.map((m) => m.name + ':' + typ(db, m.dataRef, depth + 1)).join(', ') + '}';
    }
    if (d.type === 'enum') return 'enum(' + Object.keys(d.items || {}).slice(0, 6).join(',') + ')';
    if (d.type === 'typedef') return typ(db, d.dataRef || d.baseType, depth);
    if (d.type === 'array') return '[' + typ(db, d.elementDataRef, depth + 1) + ']';
    return d.type;
}

const svcNum = (v) => (typeof v === 'string' ? parseInt(v, v.startsWith('0x') ? 16 : 10) : v);

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

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        let db = null, err = '';
        try { db = JSON.parse(fs.readFileSync(CATALOG, 'utf8')); } catch (e) { err = e.code || String(e); }
        const demo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !db);
        const result = () => probe(demo() ? DEMO : db || {});
        if (db) {
            const r = result();
            log.info('catalog: ' + Object.keys(db.interfaces || {}).length + ' interfaces, ' + r.count + ' match, 0xB512 ' + (r.found ? 'FOUND' : 'not there'));
            r.lines.forEach((l) => log.info(l.text));
        } else log.warn('catalog ' + CATALOG + ' not readable: ' + err);

        const ROWS = 11;
        let page = 0;
        const render = async () => {
            const t = ctx.theme(), r = result(), pages = Math.max(1, Math.ceil(r.lines.length / ROWS));
            page %= pages;
            const cv = ctx.canvas(1600, 520).clear(t.bg);
            G.frame(cv, t, ['Ambient light'], 0, [demo() && { text: 'DEMO' }]);
            const status = !db && !demo() ? 'Catalog not readable (' + err + ')'
                : r.found ? 'Ambient light service 0xB512 found' : r.count ? 'No 0xB512 - similar interfaces below' : 'Nothing about ambient light in the catalog';
            cv.text(status, 40, 110, 34, r.found ? t.accent2 : t.warn, { font: 'bold' });
            cv.text('Read only: nothing is sent to the car.  Page ' + (page + 1) + '/' + pages, 40, 150, 22, t.dim);
            r.lines.slice(page * ROWS, page * ROWS + ROWS).forEach((l, k) =>
                cv.text(l.text, 40, 195 + k * 30, l.head ? 24 : 21, l.hit ? t.accent2 : l.head ? t.text : t.dim, l.head ? { font: 'bold' } : {}));
            return ui.image('MAIN_GFX', cv);
        };
        const loop = ctx.loop('MAIN', 5, render);
        ui.onClick('BTN_NEXT', () => { page++; return loop && loop.kick ? loop.kick() : render(); });
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
    assert.ok(r.lines[0].hit && r.lines[1].text.includes('[get/notify/SET]') && r.lines[1].text.includes('hue:UInt16'));
    assert.strictEqual(probe({ interfaces: { 'x.Radio': { serviceId: '0x10' } } }).count, 0);
    console.log('ok');
}
