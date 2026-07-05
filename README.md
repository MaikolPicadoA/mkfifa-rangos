# MKFIFA Rangos

Web estatica para analizar jugadores de FUTBIN FC 26 por precio y price range.

## Abrir web

https://maikolpicadoa.github.io/mkfifa-rangos/

## Actualizar data desde GitHub

1. Entra al repo `mkfifa-rangos`.
2. Abre la pestana `Actions`.
3. Selecciona `Actualizar data FUTBIN`.
4. Pulsa `Run workflow`.
5. Espera a que termine en verde.
6. Abre la web y revisa arriba la fecha `Actualizado UTC`.

Si GitHub muestra error de permisos, ve a `Settings > Actions > General > Workflow permissions` y activa `Read and write permissions`.

## Actualizar data local

```bash
npm install --no-save playwright
npx playwright install chromium
npm run update:data
```
