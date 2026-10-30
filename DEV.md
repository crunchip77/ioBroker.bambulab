# Entwicklung (Fork Cloud)

## Lokal (Windows)

- Repo: `C:\Users\oppel\iobroker-dev\ioBroker.bambulab`
- **Prod-ioBroker:** MCP `iobroker-prod` (10.1.1.10)
- **Test-ioBroker:** MCP `iobroker-1` (10.1.1.111, Docker `a466d9d06dba`)

## Auf Test-Container deployen (Unraid Docker)

Vom **GitHub-Fork** installieren (wie AutoDoc), **im ioBroker-Container**:

```bash
iobroker url https://github.com/crunchip77/ioBroker.bambulab/tarball/feature/cloud-mqtt
iobroker restart bambulab.0
```

Nach Code-Änderungen: erneut `iobroker url …` mit demselben Branch, dann restart.

## Adapter testen

- Modell **H2D-Series**, Seriennummer aus Bambu-App/Studio
- **Cloud:** `connectionMode = cloud`, Bambu-E-Mail + Passwort (oder gespeichertes Cloud-Token)
- State: `bambulab.0.info.connection`
