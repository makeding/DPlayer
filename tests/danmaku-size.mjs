import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/ts/danmaku.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText;

function element() {
    return {
        children: [],
        style: {setProperty(name, value) { this[name] = value; }},
        classList: {add() {}},
        addEventListener() {},
        appendChild(child) { this.children.push(child); },
    };
}

for (const width of [1024, 512]) {
    test(`mixed danmaku sizes preserve base font, widths and lanes at ${width}px`, () => {
        const exports = {};
        vm.runInNewContext(compiled, {
            exports,
            require: name => {
                if (name === './utils') return {default: {isWebKit: false}};
                if (name === './api') return {default: {}};
                throw new Error(`Unexpected runtime import: ${name}`);
            },
            document: {createElement: element, createDocumentFragment: element},
        });
        const danmaku = Object.create(exports.default.prototype);
        danmaku.showing = true;
        danmaku.container = Object.assign(element(), {offsetWidth: width, offsetHeight: 720});
        danmaku.options = {fontSize: 24, speedRate: 1};
        danmaku.player = {fullScreen: {isFullScreen: () => false}};
        danmaku.danTunnel = {right: {}, top: {}, bottom: {}};
        const measurements = [];
        danmaku._measure = (text, fontSize) => {
            measurements.push(fontSize);
            return text.length * fontSize;
        };
        const sizes = ['big', 'big', 'medium', 'small', 'small', 'medium', undefined];
        const fragment = danmaku.draw(sizes.map(size => ({text: 'test', type: 'top', size})));
        const ratio = Math.min(width / 1024 * 1.25, 1);
        const base = 24 * ratio;
        const expectedFonts = [1.25, 1.25, 1, 0.8, 0.8, 1, 1].map(scale => base * scale);
        assert.deepEqual(measurements, expectedFonts);
        assert.equal(danmaku.container.style['--dplayer-danmaku-font-size'], `${base}px`);
        assert.equal(fragment.children.length, sizes.length);
        fragment.children.forEach((item, index) => {
            assert.equal(item.style.width, `${4 * expectedFonts[index] + 1}px`);
            assert.equal(item.style.top, `${(base + 6 * ratio) * index + 8}px`);
        });
    });
}
