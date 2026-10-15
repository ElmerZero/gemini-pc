# Validación · MCP Gemini 1.0.0

Comprobaciones realizadas el 15 de octubre de 2026 en Windows, con Node.js 22.14.0 y npm 11.11.0.

## Resultado

- `npm run check`: sintaxis correcta en la entrada gráfica, el servidor del panel, el motor, la interfaz y la entrada anterior.
- `npm test` en la instalación de desarrollo: **78 pruebas superadas, 0 fallos y 1 omitida**. La omitida ejecuta un fixture de shell POSIX y no corresponde a Windows.
- `npm run test:oauth`: integración MCP/OAuth superada con un servidor temporal en loopback, registro dinámico, PKCE, URI de callback de Google, descubrimiento de herramientas, lectura/escritura de archivos de prueba y rechazo de rutas fuera de la carpeta autorizada. Se simula el cliente; no se inicia sesión en una cuenta real de Google.

## Qué cubren las pruebas

- **Motor de administración:** configuración sin exponer secretos, conservación de credenciales y permisos, operaciones serializadas, cancelación, comprobación de salud y PID del supervisor, rutas de ejecución personalizadas, cierre idempotente y bloqueo de nuevos procesos durante el cierre.
- **Panel local:** escucha sólo en loopback, token por instancia, validación de Host/Origin, rechazo de solicitudes desde otros sitios, límites del cuerpo JSON, archivos públicos permitidos y cierre del servidor HTTP.
- **Botón de pánico:** cierre prioritario durante operaciones, cancelación del selector, bloqueo de nuevas acciones, solicitudes de cierre simultáneas y reintento sin confirmar un cierre fallido. Se comprobó la terminación real de un proceso con su descendiente en Windows.
- **Interfaz:** respuestas atrasadas descartadas, errores de conexión sin restaurar un estado obsoleto, pánico durante un guardado, conservación del foco y detalles de aprobaciones, y navegación accesible al contenido. Los encabezados Bearer/Basic y campos JSON sensibles se ocultan en los errores.
- **Aprobaciones:** identificadores concretos, secretos ocultos, comando y argumentos revisables, y rechazo de aprobación cuando no caben todos los detalles.
- **Gemini CLI:** combinación de ajustes con conservación de otras entradas, copia de respaldo y rechazo de JSON inválido.
- **Funciones anteriores:** límites de carpetas, configuración HTTPS, escritura sin inyección de variables, paquetes ZIP/TAR, instalación y reutilización de ngrok con dependencias simuladas, cierre de procesos y controles de terminal.
- **Orientación para Gemini:** instrucciones de inicio en la raíz compartida, rechazo de `..` con una alternativa clara, `git_status` sin repositorio como resultado informativo, estado de un repositorio real y Git ausente como error. Git no descubre repositorios padres fuera de la carpeta compartida ni usa variables heredadas para acceder a ellos. Las comprobaciones usan una copia aislada del servidor, sin leer su configuración privada.
- **Parches reproducibles:** aplicación sobre el commit original, conservación de cambios ajenos y saltos de línea, idempotencia y rechazo de fuentes incompatibles antes de escribir.
- **Paquete público:** lista explícita de archivos, exclusión de datos ajenos, rechazo de enlaces simbólicos, hardlinks y residuos en el destino, regeneración y manifiesto SHA-256.

## Revisión en navegador

Se recorrió el asistente de tres pasos en una instalación temporal: carpeta, perfil de sólo consulta y destino Gemini CLI. Se comprobó el guardado, el resumen, el botón Configurar Gemini CLI y el registro de actividad. La prueba escribió únicamente en la carpeta temporal, sin modificar la configuración real de Gemini CLI.

Se revisó la distribución de escritorio y a 390 × 844 píxeles. Se corrigieron los nombres accesibles de los enlaces de navegación al mostrarse como iconos. El botón Cerrar aplicación mostró su diálogo y terminó el servidor temporal.

Se revisó el modo oscuro en el asistente y se actualizó la ruta de conexión a **Conectores → + → Agregar conector personalizado**. `docs/interfaz.jpg` muestra el asistente sin rutas, cuentas ni credenciales personales. Las capturas antiguas quedan excluidas del paquete público.

En la versión 1.0.0 se pulsó **Cortar todo** durante una preparación temporal en curso. El panel confirmó el cierre, el proceso terminó y el puerto local dejó de escuchar. El botón también se revisó a 390 × 844 píxeles y permaneció visible al desplazarse por la ayuda, sin desbordamiento horizontal.

Se reinició el panel real, se restauró la conexión que ya estaba activa y se comprobó el estado saludable, conservando configuración y credenciales.

Al cargar la versión 1.0.0, la conexión real ya estaba detenida y se conservó ese estado; se verificó la versión y el botón de pánico en el panel actualizado.

## Copia para GitHub

El paquete contiene sólo los archivos de la lista permitida y un manifiesto nuevo. Se revisaron los ejemplos del código y las pruebas y se sustituyeron las rutas y el usuario predeterminado por datos neutros. La copia se comprobó contra los valores privados locales disponibles, sin coincidencias. Las credenciales, registros, configuraciones generadas e historial Git no están incluidos. Esta comprobación no cubre secretos que alguien añada en cambios futuros.

En la copia limpia, `npm test` pasó con **64 pruebas superadas, 0 fallos y 8 omitidas**: siete requieren el motor descargado y una un fixture POSIX. La primera configuración de la aplicación instala el motor fijado y aplica sus mejoras.

## Límites

- El usuario informó que la conexión funcionó. Se comprobó la restauración del túnel ya configurado, pero no se inició sesión ni se operó la cuenta real de Gemini durante esta validación. La disponibilidad del conector personalizado depende de Google y de la cuenta.
- No se ha iniciado una sesión real de Gemini CLI con la configuración generada.
- El selector nativo de carpetas se cubrió con un adaptador de prueba; no se operó el diálogo de Windows. Los lanzadores de doble clic y las variantes macOS/Linux no se ejecutaron en esta validación. El panel real se arrancó directamente mediante Node.js en Windows.
- Se conserva el servidor MCP 4.6.1 fijado en `UPSTREAM.json`. Se renovó su motor de administración; no se reescribieron el protocolo ni OAuth. No se declara validada toda la suite del servidor original ni auditadas todas sus dependencias.

## Repetir

```powershell
npm run check
npm test
npm run test:oauth
```

Las pruebas utilizan directorios y credenciales temporales. La excepción de HTTP local para OAuth sólo existe en el proceso de prueba; la conexión web real exige HTTPS y OAuth.
