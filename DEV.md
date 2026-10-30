# Entwicklung (Fork Cloud)

## Lokal (Windows)

- Repo: `C:\Users\oppel\iobroker-dev\ioBroker.bambulab`
- **Prod-ioBroker:** MCP `iobroker-prod` (10.1.1.10)
- **Test-ioBroker:** MCP `iobroker-1` (10.1.1.111, Docker `a466d9d06dba`)

## Auf Test-Container deployen

Im Container (SSH/Shell), nachdem der Ordner dort liegt oder per `git pull`:

```bash
cd /pfad/zu/ioBroker.bambulab
npm install
iobroker url .
iobroker restart bambulab.0
```

Oder: Ordner nach `/opt/iobroker/node_modules/iobroker.bambulab` kopieren und Instanz neu starten.

## Adapter testen

- Modell **H2D-Series**, Seriennummer aus Bambu-App/Studio
- **Cloud:** `connectionMode = cloud`, Bambu-E-Mail + Passwort (oder gespeichertes Cloud-Token)
- State: `bambulab.0.info.connection`
