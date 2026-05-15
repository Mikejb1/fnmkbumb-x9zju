# Portfolio-Tracker - Mobile PWA mit Login

Privater Portfolio-Tracker für iPhone. Daten werden mit AES-GCM lokal im Browser verschluesselt - das Passwort verlaesst dein Geraet nie.

## Was ist hier drin?

- `index.html` - die komplette App (HTML + CSS + JS in einer Datei)
- `manifest.json` - PWA-Manifest fuer "Zum Home-Bildschirm hinzufuegen"
- `icon-192.png`, `icon-512.png` - App-Icons (musst du selbst erstellen, siehe unten)
- `README.md` - diese Anleitung

## Schritt 1: GitHub Pages aufsetzen (~5 Minuten)

1. **GitHub-Account** erstellen (falls noch nicht vorhanden): https://github.com/signup - kostenlos
2. **Neues Repository anlegen**:
   - Auf https://github.com/new
   - Name: z.B. `portfolio-private` (irgendwas Unauffaelliges)
   - Sichtbarkeit: **Public** (Private Pages braucht GitHub Pro)
   - "Add a README" haken setzen
   - "Create repository" klicken
3. **Dateien hochladen**:
   - Im Repo auf "Add file" -> "Upload files"
   - Die drei Dateien (`index.html`, `manifest.json`, beide Icons) reinziehen
   - "Commit changes" klicken
4. **GitHub Pages aktivieren**:
   - Im Repo: Settings -> Pages
   - Source: "Deploy from a branch"
   - Branch: `main` / Folder: `/ (root)`
   - "Save" klicken
   - Nach 1-2 Minuten ist deine Seite live unter: `https://DEIN-USERNAME.github.io/portfolio-private/`

## Schritt 2: Icons erstellen (optional aber empfohlen)

Damit das App-Icon auf dem iPhone gut aussieht, brauchst du zwei PNG-Bilder:

- `icon-192.png` (192x192 Pixel)
- `icon-512.png` (512x512 Pixel)

Einfacher Weg: Online-Generator wie https://favicon.io/favicon-generator/ - dort einen Buchstaben + Farbe waehlen, Pack runterladen, die beiden PNGs in den Ordner kopieren.

Ohne Icons funktioniert die App auch, sieht auf dem Home-Bildschirm nur weniger nett aus.

## Schritt 3: Erstmaliger Setup auf dem iPhone

1. Auf dem iPhone in Safari die GitHub-Pages-URL oeffnen
2. **Setup-Screen** erscheint
3. **Passwort waehlen** - mindestens 6 Zeichen, gut merken! Wichtig: Wenn du es vergisst, sind die Daten verloren (kein Reset moeglich).
4. **JSON-Daten einfuegen** - kopiere die untenstehende Vorlage und passe sie an deine echten Werte an
5. "Setup abschliessen" - die Daten werden verschluesselt und im Browser gespeichert
6. App ist einsatzbereit

### JSON-Vorlage zum Einfuegen

Diese Vorlage enthaelt deine 5 bekannten Positionen aus dem Cowork-Tracker als Start. Passe Beträge an wenn sich was geaendert hat:

```json
[
  {
    "id": "amundi",
    "name": "Amundi Core MSCI World ETF",
    "symbol": "ETF146",
    "isin": "IE000BI8OT95",
    "type": "ETF",
    "shares": 2.870678,
    "costPrice": 138.02,
    "manualPrice": 152.11
  },
  {
    "id": "globalx",
    "name": "Global X Video Games ETF",
    "symbol": "A2QKQ5",
    "isin": "IE00BLR6Q544",
    "type": "ETF",
    "shares": 59,
    "costPrice": 12.59,
    "manualPrice": 10.67
  },
  {
    "id": "sol",
    "name": "Solana",
    "symbol": "SOL",
    "type": "Crypto",
    "shares": 34.56094,
    "costPrice": 93.98,
    "cgId": "solana"
  },
  {
    "id": "xrp",
    "name": "Ripple",
    "symbol": "XRP",
    "type": "Crypto",
    "shares": 2198.616525,
    "costPrice": 1.46,
    "cgId": "ripple"
  },
  {
    "id": "now",
    "name": "ServiceNow",
    "symbol": "NOW",
    "isin": "US81762P1021",
    "type": "Aktie",
    "shares": 56,
    "costPrice": 109.93,
    "manualPrice": 81.82
  }
]
```

**Wichtige Felder:**
- `cgId` (CoinGecko-ID): nur fuer Krypto-Positionen, holt automatisch Live-Preise. Liste der IDs: https://api.coingecko.com/api/v3/coins/list
- `manualPrice`: fuer Aktien/ETFs, da kein Live-Fetch verfuegbar. Aktualisierst du gelegentlich in der App selbst (Button "Werte bearbeiten").
- `costPrice` ist der Einstandskurs pro Stueck in EUR.

## Schritt 4: Auf dem iPhone als App installieren

1. Die GitHub-Pages-URL in Safari oeffnen
2. Auf das **Teilen-Icon** unten in der Mitte tippen (Quadrat mit Pfeil nach oben)
3. **"Zum Home-Bildschirm"** auswaehlen
4. Name bestaetigen, "Hinzufuegen" antippen
5. Auf dem Home-Bildschirm erscheint jetzt ein Portfolio-Icon - das oeffnet die App im Vollbild-Modus, sieht aus wie eine native App

## Datenmanagement

- **Live-Krypto-Preise** kommen von CoinGecko (gratis, keine Anmeldung noetig)
- **Aktien/ETF-Werte** sind manuell - oeffne in der App "Werte bearbeiten" auf einer Karte und passe den Kurs an
- **Slider fuer Ziel** (Jahr + Betrag) werden bei Aenderung gespeichert
- **Refresh-Button** oben rechts holt frische Krypto-Preise
- **Theme-Toggle** (Sonne/Mond): hell oder dunkel
- **Logout-Button** (Pfeil nach rechts): meldet ab, Daten bleiben verschluesselt gespeichert

## Sicherheitshinweis

- Daten werden **lokal auf deinem iPhone** mit AES-GCM verschluesselt gespeichert (Web Crypto API, 150.000 PBKDF2-Iterationen)
- Das Passwort wird **niemals uebertragen** - die Verschluesselung passiert komplett im Browser
- Selbst wenn jemand die URL findet, sieht er nur den Login-Screen - die verschluesselten Daten sind ohne Passwort unbrauchbar
- **Wichtig:** Verliere das Passwort nicht. Es gibt keinen "Passwort vergessen"-Knopf. Wenn weg, dann musst du neu setuppen.
- Browser-Daten loeschen = Portfolio-Daten weg. Wenn das ein Problem ist, koennen wir einen Export/Import-Mechanismus einbauen.

## Cross-Device

Wenn du die App auch auf einem zweiten Geraet (z.B. Mac oder iPad) nutzen willst:
1. Gleiche URL aufrufen
2. Setup nochmal durchlaufen mit demselben Passwort
3. Dieselben JSON-Daten einfuegen

Die Daten sind dann separat auf jedem Geraet (kein automatischer Sync). Aenderungen auf einem Geraet erscheinen nicht automatisch auf dem anderen.

## Bei Problemen

- Krypto-Preise laden nicht? CoinGecko hat ein Rate-Limit (~10-30 Calls/Min ohne Account). Einfach paar Sekunden warten und Refresh klicken.
- Setup-Wizard kommt wieder, obwohl ich schon eingerichtet hatte? Browser-Daten/Cache wurden geloescht. Setup nochmal mit demselben Passwort durchlaufen.
- "Falsches Passwort" obwohl korrekt? Genau pruefen - Gross-/Kleinschreibung zaehlt. Bei Cookies/Privatmodus kann localStorage anders sein.

## Fragen?

Aenderungen am Code (Design, Features, Logik) - jederzeit kannst du im Cowork-Chat sagen "passe das Mobile-Portfolio so an...".
