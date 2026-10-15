# MCP Gemini · 1.0.0

Una interfaz gráfica en español, con modo oscuro predeterminado, para conectar una carpeta de tu PC con Gemini. Elige qué compartir, decide qué puede hacer Gemini y sigue los pasos de conexión. No necesitas escribir comandos ni editar archivos de configuración.

## Abrir la app

En Windows, haz doble clic en **`Abrir Gemini.vbs`**. El panel se abre en tu navegador, sin una consola. Si Windows bloquea los scripts VBS, abre **`iniciar-gemini.cmd`**: muestra el mismo panel y mantiene una ventana de consola abierta.

La app necesita **Node.js 22 o posterior**, disponible en [nodejs.org](https://nodejs.org/). En otros sistemas, ejecuta `./iniciar-gemini.sh` o `npm start`.

La dirección habitual es `http://127.0.0.1:3210`. Este panel sólo acepta conexiones desde tu equipo. No es la dirección que debes pegar en Gemini.

## La primera vez

1. **Carpeta.** Pulsa «Elegir carpeta» o pega una ruta. También puedes aceptar la carpeta sugerida: se creará al guardar.
2. **Permisos.** Elige leer y editar archivos o sólo consultar. La ejecución de comandos está dentro de las opciones avanzadas y necesita una aceptación adicional.
3. **Conexión.** Elige Gemini web o Gemini CLI y guarda.

Los ajustes existentes aparecen en el formulario. La cuenta de autorización y las credenciales de ngrok se conservan si no las reemplazas.

### Usar Gemini web

Necesitas una cuenta de [ngrok](https://dashboard.ngrok.com/get-started/your-authtoken) para abrir la conexión HTTPS. La app busca el programa y lo descarga de su fuente oficial si falta. Pega tu authtoken en el campo de contraseña del asistente. Puedes dejar vacía la dirección pública para detectarla automáticamente.

Define un usuario y una contraseña **para este MCP**, distintos de tu cuenta de Google. Si ya existen, puedes conservarlos. Después de guardar:

1. Pulsa **Iniciar conexión** y espera a que el panel confirme que el MCP está disponible.
2. Copia la URL que termina en `/mcp`.
3. En [Gemini](https://gemini.google.com/), entra en **Conectores → signo + → Agregar conector personalizado** y agrega esa URL.
4. Autoriza con el usuario y la contraseña de este MCP.

**La disponibilidad depende de tu cuenta de Gemini.** Si no aparece «Agregar conector personalizado», consulta la [ayuda oficial de Gemini](https://support.google.com/gemini/answer/17209137?hl=es). Esta app no activa funciones de tu cuenta.

El panel confirma el estado del servidor y del túnel; no afirma que hayas completado el enlace dentro de Google. Tu PC debe permanecer encendida. Usa **Detener conexión** para cerrar el acceso web y **Cerrar aplicación** para cerrar también el panel. Cerrar sólo la pestaña deja la app funcionando.

**Botón de pánico: Cortar todo.** Está siempre visible en la parte superior. Un clic cancela las operaciones en curso, detiene el servidor y el túnel iniciados por esta app, y cierra el panel. No pide confirmación ni espera a que termine una instalación. Si el cierre falla, muestra el error y permite reintentar; sólo confirma que está cerrado cuando los procesos se han detenido. Para volver a usar la app, abre de nuevo su lanzador. No cierra el navegador ni otras aplicaciones; una conexión iniciada por Gemini CLI se detiene desde ese cliente.

Si ya tienes un proxy HTTPS, puedes elegirlo en las opciones avanzadas. Debe reenviar `/mcp`, `/oauth/*` y `/.well-known/*` al puerto del servidor. La app no configura un proxy externo.

### Usar Gemini CLI

Selecciona Gemini CLI, guarda y pulsa el botón para instalar la configuración. La app agrega `mcpServers.mi-pc` a `~/.gemini/settings.json`, conserva las otras opciones y crea una copia de respaldo antes de cambiar un archivo existente.

Gemini CLI debe estar instalado y configurado por separado. Reinícialo y usa `/mcp` para comprobar el acceso. El cliente inicia el MCP automáticamente; no necesita un túnel ni el botón Iniciar. La configuración usa `trust: false` para conservar las confirmaciones del cliente. [Documentación de Gemini CLI](https://geminicli.com/docs/tools/mcp-server/).

## Permisos y solicitudes

El perfil inicial permite leer y editar archivos en la carpeta elegida. Cámara, micrófono y control del escritorio permanecen desactivados. El perfil de sólo lectura evita modificaciones.

El perfil avanzado de comandos usa los permisos de tu usuario: la carpeta de trabajo **no aísla los procesos del resto del sistema**. Las solicitudes sujetas a aprobación se revisan desde el panel; puedes aprobarlas o rechazarlas. El motor conserva sus confirmaciones para operaciones críticas.

Las contraseñas no se muestran en el estado del panel ni se guardan en el navegador. La configuración y las credenciales permanecen en `servidor/.env` y `servidor/.private/`. No compartas estas carpetas ni los registros privados.

## Si algo no funciona

- Usa el diagnóstico de la ayuda para comprobar los requisitos. Los errores se muestran en el panel y en Actividad.
- Si otro ngrok usa tu endpoint, detén esa conexión antes de reintentar.
- Si no abre el navegador, ejecuta `iniciar-gemini.cmd` y abre la dirección que aparece.
- Si el puerto del panel está ocupado por otra aplicación, ejecuta `node gemini-gui.cjs --port 3211`.
- En Linux, el selector visual usa `zenity`. Si no está instalado, puedes pegar la ruta directamente.
- Para volver a la interfaz de terminal anterior, usa `npm run terminal`.

### Carpetas y Git

Gemini debe empezar con `list_files` usando `path: "."`. El punto representa la carpeta que compartiste. `..` apunta a su carpeta superior y se rechaza si sale de los límites autorizados. Para usar otra carpeta, cámbiala en **Editar configuración**.

Una carpeta normal no necesita Git para leer o editar archivos. Si se consulta `git_status` en una carpeta sin repositorio, el servidor devuelve `isRepository: false` con una explicación, sin crear un repositorio. Los errores de Git ausente, permisos o tiempo de espera siguen siendo errores. Las instrucciones enviadas a Gemini explican estas diferencias y le indican que no inicialice Git sin que se lo pidas.

## Preparar una copia para GitHub

Ejecuta `npm run package:public` y sube únicamente el contenido de **`para-github/gemini-pc`**. El empaquetador copia una lista explícita de código, documentación y pruebas; no copia la instalación completa. Genera un manifiesto SHA-256 de los archivos incluidos y rechaza enlaces simbólicos o archivos inesperados que ya estén en el destino.

La copia pública excluye credenciales, archivos `.env`, el servidor instalado, carpetas de trabajo, configuraciones generadas de Gemini CLI, registros, cachés, historial Git y capturas antiguas. La imagen de `docs/interfaz.jpg` muestra el asistente sin datos personales. La configuración local de quien prepara el paquete permanece en su equipo.

El archivo `.gitignore` también excluye estos datos durante el uso normal. Antes de publicar cambios futuros, vuelve a generar la copia y revisa los archivos que hayas añadido al código o a la documentación; una lista de archivos no puede detectar todos los secretos que alguien escriba manualmente en el código.

## Motor y mantenimiento

La versión 1.0.0 separa tres capas: `ui/` contiene la interfaz, `lib/gui-server.cjs` sirve el panel local y `lib/app-engine.cjs` administra configuración, operaciones y procesos. Las operaciones se serializan, pueden cancelarse y el estado se comprueba contra el proceso real.

Se conserva el servidor MCP 4.6.1 de [vicktorgabriel/mcp-server](https://github.com/vicktorgabriel/mcp-server), revisión `fe1a8e679579796a2c2236ce444da52ae9ddf93b`, con su autenticación OAuth y herramientas. Se ha rehecho el motor de administración, no el protocolo ni la autenticación. `lib/server-patches.cjs` aplica las mejoras de orientación sobre carpetas y Git tanto a instalaciones existentes como a nuevas descargas, y verifica su compatibilidad antes de editar. La instalación inicial del servidor necesita Git y npm si no está incluido en tu carpeta.

Para comprobar el código:

```powershell
npm run check
npm test
npm run test:oauth
```

Las pruebas trabajan con carpetas y credenciales temporales. Consulta `VALIDACION.md` para conocer las comprobaciones realizadas y sus límites. Los comandos anteriores de `gemini-pc.cjs` y su modo `stdio` siguen disponibles.

Herramienta independiente, con una interfaz inspirada en Gemini. No es un producto oficial de Google.
