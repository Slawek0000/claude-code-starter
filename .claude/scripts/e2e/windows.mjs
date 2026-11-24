// Proces serwera E2E na Windows: odpowiedniki `ps -o lstart=`, `lsof` i sygnalow grupy procesow z serwer.mjs.
//
// Windows nie ma `ps -o`, `lsof` ani grup procesow (process.kill(-pid) i SIGCONT/SIGSTOP nie istnieja): bez tego modulu kazdy
// start E2E konczyl sie „komenda startu nie wystartowala”, zanim pipeline sprawdzil kod wyjscia (projekt od zera = STOP zamiast
// `odroczone`). Czas startu procesu czytamy z PowerShella w ISO 8601 UTC — format niezalezny od locale sesji (jak locale C w `ps`).
// Port: Get-NetTCPConnection (stan Listen jako enum, nie lokalizowany tekst netstata). Zatrzymanie: `taskkill /T /F` — cale drzewo
// procesow (cmd.exe z shell: true -> npm -> vite), bo potomek bez rodzica trzymalby port jak w P19.

import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const LIMIT_PID_STARTU_MS = 20000

/**
 * Argumenty PowerShella ze skryptem w -EncodedCommand (base64 UTF-16LE): `-Command` przepuszcza skrypt przez parser wiersza
 * polecen powershell.exe, ktory gubi cudzyslowy wewnatrz (komenda startu `echo "…" && exit 1` nie trafiala do logu).
 * @param {string} skrypt @returns {string[]}
 */
// Bez rekordow postepu: w trybie -EncodedCommand trafiaja na stderr jako „#< CLIXML” i zasmiecaja log.
const argumentyPs = (skrypt) => ['-NoProfile', '-NonInteractive', '-EncodedCommand',
  Buffer.from(`$ProgressPreference = 'SilentlyContinue'; ${skrypt}`, 'utf16le').toString('base64')]

/** @param {string} skrypt @returns {{ ok: boolean, wyjscie: string }} wynik PowerShella; ok = false przy braku programu albo kodzie != 0 */
function powershell(skrypt) {
  const w = spawnSync('powershell.exe', argumentyPs(skrypt), { encoding: 'utf8', windowsHide: true })
  return { ok: !w.error && w.status === 0, wyjscie: (w.stdout ?? '').trim() }
}

/** @param {number} pid @returns {boolean} */
const poprawnyPid = (pid) => Number.isInteger(pid) && pid > 0

/**
 * @param {number} pid
 * @returns {string | null} czas startu procesu (ISO 8601 UTC) albo null, gdy procesu nie ma
 */
export function czasStartuWindows(pid) {
  if (!poprawnyPid(pid)) return null
  const w = powershell(`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if (-not $p) { exit 1 }; [Console]::Out.Write($p.StartTime.ToUniversalTime().ToString('o'))`)
  return w.ok && w.wyjscie ? w.wyjscie : null
}

/**
 * Proces nasluchujacy na porcie TCP: proces, null (brak nasluchu) albo undefined (PowerShell niedostepny — wtedy decyduje sonda).
 * @param {number} port
 * @returns {{ pid: number, komenda: string } | null | undefined}
 */
export function procesNaPorcieWindows(port) {
  const w = powershell([
    `$c = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1`,
    'if (-not $c) { exit 0 }',
    '$k = (Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue).CommandLine',
    '[Console]::Out.Write("$($c.OwningProcess)`n$k")',
  ].join('; '))
  if (!w.ok) return undefined
  const [pierwsza = '', ...reszta] = w.wyjscie.split('\n')
  const pid = Number(pierwsza.trim())
  if (!poprawnyPid(pid)) return null
  return { pid, komenda: reszta.join('\n').trim() || '(komenda nieznana)' }
}

/**
 * Zatrzymuje proces z calym drzewem potomkow (`taskkill /T /F`). Proces, ktorego juz nie ma, nie jest bledem.
 * @param {number} pid
 */
export function zatrzymajDrzewoWindows(pid) {
  if (poprawnyPid(pid)) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
}

/** @param {string} tekst @returns {string} literal napisu PowerShella w apostrofach */
const napisPs = (tekst) => `'${tekst.replaceAll("'", "''")}'`

/**
 * Start komendy serwera w tle. `spawn(..., { detached: true })` daje na Windows proces bez konsoli: program uruchomiony z niego
 * (npm, node, takze PowerShell) pisze do nowej konsoli, nie do przekazanego pliku albo potoku (pusty log, projekt od zera nie
 * zostaje rozpoznany). Dlatego zwykly (nieodlaczony) PowerShell uruchamia przez Start-Process cmd.exe z ukryta konsola, a cmd
 * przekierowuje wyjscie komendy do logu (`cmd /d /s /c "(<komenda>) > log 2>&1"` — jak spawn z shell: true: /s zdejmuje skrajne
 * cudzyslowy, a reszta jest parsowana raz, wiec `=>` w cudzyslowie komendy nie staje sie przekierowaniem). PowerShell siedzi w jobie libuv (KILL_ON_JOB_CLOSE) i ginie z koncem skryptu, ale job ma
 * SILENT_BREAKAWAY_OK — cmd.exe ze Start-Process jest poza jobem i serwer zyje dalej. Dopoki skrypt trwa, PowerShell czeka na
 * serwer i konczy sie jego kodem wyjscia: zdarzenie `exit` zwroconego procesu niesie kod serwera. Blad samego PowerShella
 * (stderr) trafia do logu, gdy PID-u nie ma.
 * @param {{ projekt: string, start: string, log: string, env: NodeJS.ProcessEnv }} o
 * @returns {{ proces: import('node:child_process').ChildProcess, pid: Promise<number | null> }} pid: cmd.exe serwera (null = brak);
 *   proces zwracany od razu, zeby wolajacy podpial `exit` przed czekaniem na PID (szybka smierc serwera nie gubi kodu)
 */
export function uruchomWTleWindows({ projekt, start, log, env }) {
  const polecenie = [
    "$ErrorActionPreference = 'Stop'",
    // Jeden napis ArgumentList PowerShell 5.1 przekazuje do CreateProcess bez zmian.
    // Nawias: przekierowanie obejmuje cala komende, takze czlony po `&&` (bez niego trafialo tylko do ostatniego).
    `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList ${napisPs(`/d /s /c "(${start}) > "${log}" 2>&1"`)} -WorkingDirectory ${napisPs(projekt)} -WindowStyle Hidden -PassThru`,
    // Uchwyt odczytany od razu: bez niego ExitCode procesu ze Start-Process bywa pusty po WaitForExit.
    '$null = $p.Handle',
    '[Console]::Out.WriteLine($p.Id)',
    '$p.WaitForExit()',
    'exit $p.ExitCode',
  ].join('; ')
  const proces = spawn('powershell.exe', argumentyPs(polecenie), {
    cwd: projekt, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env,
  })
  let bledy = ''
  proces.stderr?.on('data', (dane) => { bledy += String(dane) })
  /** @type {Promise<number | null>} */
  const pid = new Promise((gotowe) => {
    let bufor = ''
    let zakonczone = false
    const koniec = (/** @type {number | null} */ wynik) => {
      // PID z stdout, potem `close` po smierci PowerShella — liczy sie tylko pierwsze zakonczenie.
      if (zakonczone) return
      zakonczone = true
      clearTimeout(limit)
      proces.stdout?.removeAllListeners('data')
      proces.stdout?.destroy()
      if (wynik === null) appendFileSync(log, `[autopilot-e2e] start przez PowerShell nie dal PID-u serwera\n${bledy}`)
      proces.stderr?.destroy()
      gotowe(wynik)
    }
    const limit = setTimeout(() => koniec(null), LIMIT_PID_STARTU_MS)
    proces.once('error', () => koniec(null))
    // `close`, nie `exit`: po `close` stderr PowerShella jest juz odczytany w calosci.
    proces.once('close', () => koniec(null))
    proces.stdout?.on('data', (dane) => {
      bufor += String(dane)
      const linia = bufor.split(/\r?\n/)[0]
      if (bufor.includes('\n')) koniec(poprawnyPid(Number(linia.trim())) ? Number(linia.trim()) : null)
    })
  })
  return { proces, pid }
}

/** @param {number} pid @returns {string} komenda zatrzymania obcego procesu dla operatora */
export const komendaZatrzymaniaWindows = (pid) => `taskkill /PID ${pid} /T /F`

/** @param {number} port @returns {string} komenda pokazujaca, kto trzyma port */
export const komendaPortuWindows = (port) => `Get-NetTCPConnection -State Listen -LocalPort ${port}`
