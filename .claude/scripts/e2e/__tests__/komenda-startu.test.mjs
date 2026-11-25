// Domyslna komenda startu E2E (komendaStartu adaptera) przekazuje argumenty do skryptu projektu bez `--` na poczatku.
// pnpm (od v7) przekazuje `--` dalej: `pnpm run dev -- --mode e2e --port 5174` dawalo `vite -- --mode e2e --port 5174`, Vite
// ignorowal argumenty i wstawal na 5173 bez trybu e2e, a `e2e.mjs start` po limicie zglaszal, ze port E2E nie odpowiada
// (smoke dashboard-sprzedazy, 2026-11-25). npm bez `--` zjada flagi jako wlasna konfiguracje, wiec npm `--` potrzebuje.
//
// Test jest neutralny wobec stacku: dotyczy komendy w postaci `<pm> run <skrypt> <argumenty>`; adapter z inna komenda go pomija.
//
// Uruchomienie: node --test .claude/scripts/e2e/__tests__/komenda-startu.test.mjs

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { DOMYSLNY_PORT, komendaStartu } from '../adapter.mjs'

const MENEDZERY = ['npm', 'pnpm', 'yarn', 'bun']
const POSTAC = /^(\S+) run (\S+)(?: (.*))?$/

/** @param {string} pm @returns {boolean} menedzer jest w PATH */
const dostepny = (pm) => spawnSync(pm, ['--version'], { shell: true, encoding: 'utf8', timeout: 30_000 }).status === 0

for (const pm of MENEDZERY) {
  const komenda = komendaStartu(pm, DOMYSLNY_PORT)
  const postac = POSTAC.exec(komenda)

  test(`komendaStartu(${pm}): argumenty skryptu bez dwukreslnika dla menedzera, ktory go przekazuje`, { skip: !postac && 'komenda adaptera nie ma postaci <pm> run <skrypt>' }, () => {
    const argumenty = postac?.[3] ?? ''
    if (pm === 'npm') assert.match(argumenty, /^-- /, `npm bez \`--\` traktuje flagi jako wlasna konfiguracje: ${komenda}`)
    else assert.doesNotMatch(argumenty, /(^| )--( |$)/, `${pm} przekazuje skryptowi flagi po jego nazwie, a \`--\` moze trafic do skryptu (pnpm), ktory wtedy ignoruje argumenty: ${komenda}`)
  })

  test(`komendaStartu(${pm}): skrypt projektu dostaje port E2E jako pierwsze argumenty (na zywo)`, { skip: (!postac && 'komenda adaptera nie ma postaci <pm> run <skrypt>') || (!dostepny(pm) && `brak ${pm} w PATH`) }, () => {
    const [, , skrypt] = /** @type {RegExpExecArray} */ (postac)
    const projekt = mkdtempSync(join(tmpdir(), 'komenda-startu-'))
    try {
      writeFileSync(join(projekt, 'argv.cjs'), 'console.log("ARGV" + JSON.stringify(process.argv.slice(2)))\n')
      writeFileSync(join(projekt, 'package.json'), JSON.stringify({ name: 'komenda-startu', version: '1.0.0', private: true, scripts: { [skrypt]: 'node argv.cjs' } }))
      const w = spawnSync(komenda, { cwd: projekt, shell: true, encoding: 'utf8', timeout: 60_000 })
      const linia = `${w.stdout}`.split(/\r?\n/).find((l) => l.startsWith('ARGV'))
      assert.ok(linia, `skrypt nie wypisal argumentow (kod ${w.status}): ${w.stderr || w.stdout}`)
      const argv = JSON.parse(linia.slice('ARGV'.length))
      assert.notEqual(argv[0], '--', `skrypt dostal \`--\` na poczatku, wiec Vite zignoruje argumenty: ${JSON.stringify(argv)}`)
      const port = argv.indexOf('--port')
      assert.ok(port >= 0 && argv[port + 1] === String(DOMYSLNY_PORT), `skrypt nie dostal --port ${DOMYSLNY_PORT}: ${JSON.stringify(argv)}`)
    } finally {
      rmSync(projekt, { recursive: true, force: true })
    }
  })
}
