# Portfolio-App Wartung

Diese Hilfen sind fuer die vier produktiven Portfolios gedacht:

- Michael: `index.html`
- Bruder: `bruder/index.html`
- Person1: `person1/index.html`
- Person2: `person2/index.html`

## Neue Struktur

Die produktiven HTML-Dateien bleiben weiterhin direkt von GitHub Pages nutzbar. Fuer die Wartung gibt es aber jetzt eine gemeinsame Quelle:

- `src/app.template.html` enthaelt die HTML-Struktur der gemeinsamen App.
- `src/app.css` enthaelt das gemeinsame Design.
- `src/js/*.js` enthaelt die gemeinsame App-Logik in Themen-Dateien.
- `src/app.js` ist der daraus erzeugte Bundle-Schnappschuss.
- `src/accounts.json` enthaelt die Konto-spezifischen Werte fuer Michael, Bruder, Person1 und Person2.
- `worker/worker.js` enthaelt den Cloudflare-Worker-Code, der zur App-Version gehoert.
- `tools/build-account-html.js` erzeugt daraus alle vier produktiven HTML-Dateien.
- `tools/check-portfolio-maintenance.js` prueft Syntax, Konto-Trennung und ob die produktiven Dateien exakt aus der Quelle reproduzierbar sind.
- `tools/check-worker.js` prueft Worker-Syntax, Auth-Pflicht und die erwarteten Worker-Actions.
- `tools/smoke-portfolio-pages.js` prueft die vier Einstiegsseiten. Wenn Playwright verfuegbar ist, als echter Browser-Test; sonst als statischer Smoke-Test.
- `tools/check-all.js` fuehrt alle Checks gemeinsam aus.

## Standard-Ablauf bei Aenderungen

1. HTML-Struktur in `src/app.template.html`, Design in `src/app.css` oder Logik in den Dateien unter `src/js/` aendern.
2. Konto-spezifische Werte nur in `src/accounts.json` aendern.
3. Produktive Dateien bauen:

```sh
node tools/build-account-html.js
```

4. Alle Checks ausfuehren:

```sh
node tools/check-all.js
```

5. Falls nur ein Bereich betroffen ist, koennen einzelne Checks direkt ausgefuehrt werden:

```sh
node tools/check-portfolio-maintenance.js
node tools/check-worker.js
node tools/smoke-portfolio-pages.js
```

## Was der Check prueft

- JavaScript-Syntax aller eingebetteten Scripts.
- Konto-Trennung: `USER_KEY` muss je Datei zum passenden Account passen.
- Der alte sichtbare Frontend-Token darf nicht wieder auftauchen.
- `AI_APP_TOKEN` muss leer bleiben.
- Alle produktiven Dateien muessen nach Normalisierung gleich aufgebaut sein.
- Wichtige UI-Anker und Funktionen muessen weiterhin vorhanden sein.
- Alle Dateien brauchen eigene verschluesselte Startdaten (`BAKED_BLOB`).
- Alle produktiven HTML-Dateien muessen exakt aus `src/app.template.html` + `src/app.css` + `src/app.js` + `src/accounts.json` reproduzierbar sein.
- Der Worker muss ohne konfigurierte Auth-Hashes geschlossen bleiben.
- Die vier Einstiegsseiten duerfen keine Template-Platzhalter enthalten.

## Erlaubte Unterschiede zwischen den Accounts

Diese Unterschiede sind normal:

- Seitentitel / Web-App-Titel / sichtbarer Login- und Header-Titel
- `USER_KEY`
- `BAKED_BLOB`

Alles andere sollte aus der gemeinsamen Vorlage kommen. Wenn der Check eine Abweichung meldet, wurde wahrscheinlich direkt an einer produktiven Datei editiert oder nur ein Portfolio geaendert.

## Wichtig

Die produktiven Dateien bleiben die Dateien, die du zu GitHub hochlaedst. Die `src`-Dateien und `tools` helfen dabei, sie sauber und synchron zu erzeugen.
