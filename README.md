# FUTBIN Rangos

Web local para analizar jugadores de FUTBIN FC 26 por rangos de media y precio.

## Uso rapido

Abre `index.html` en el navegador o ejecuta:

```bash
npm run start
```

## Actualizar jugadores

FUTBIN protege la pagina contra bots, por eso el proyecto trae un importador de texto en lugar de depender de scraping automatico.

1. Abre `https://www.futbin.com/latest?page=1&show_cards=1`.
2. Copia el bloque de texto donde aparecen los jugadores.
3. Pega el contenido en `data/futbin-raw.txt`.
4. Ejecuta:

```bash
npm run parse
```

El script reemplaza `data/players.json`, que es lo que lee la web.
