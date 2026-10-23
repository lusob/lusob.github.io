# IPTV web

Reproductor IPTV para cuentas **Xtream Codes**, hecho solo con HTML, CSS y JavaScript (sin servidor propio ni compilación). Funciona en el navegador del móvil, del ordenador, de la tele y del Tesla.

**App:** https://lusob.github.io/iptv/

## Empezar

1. Abre https://lusob.github.io/iptv/.
2. Escribe el **servidor**, el **usuario** y la **contraseña** que te dio tu proveedor. También puedes pegar en «Servidor» la URL de la lista (`…/get.php?username=…&password=…`), y los campos se rellenan solos.
3. Pulsa **Entrar**.

Tus credenciales, favoritos y ajustes solo se guardan en **tu navegador** (`localStorage`). La app solo habla con tu proveedor, y con tu proxy si configuras uno. Cada navegador o dispositivo se configura por separado, salvo que uses el grabador de Raspberry Pi (ver más abajo).

Si al entrar da un error de conexión, probablemente necesitas un proxy (siguiente apartado).

## ¿Hace falta un proxy?

La app se sirve por **HTTPS**, y el navegador bloquea dos cosas:

1. llamar a un servidor `http://` desde una página `https://` (contenido mixto);
2. leer respuestas de servidores que no envían cabeceras **CORS**.

- **Si tu proveedor usa `https://` y permite CORS**, la app funciona sin proxy.
- **Si no** (es lo más habitual), monta el proxy gratuito de abajo. Después pon su URL en **Avanzado → Proxy** al entrar, o más tarde en **Ajustes**.

### Proxy con Cloudflare Workers (gratis)

El código está en [`proxy/worker.js`](proxy/worker.js).

1. En https://dash.cloudflare.com ve a **Workers & Pages → Create → Hello World**.
2. Sustituye el código por el de `proxy/worker.js` y pulsa **Deploy**.
3. Recomendado: en **Settings → Variables** añade `ALLOWED_ORIGINS = https://lusob.github.io`, para que nadie más pueda usar tu proxy.
4. Copia la URL del worker (`https://<nombre>.<tu-subdominio>.workers.dev`) en el campo Proxy de la app.

Con la línea de comandos también se puede: `npx wrangler deploy proxy/worker.js --name iptv-proxy --compatibility-date 2024-09-01`.

Ten en cuenta:
- Cloudflare no deja que un Worker llame a un servidor identificado **solo por su IP** (error 1003). Si tu proveedor usa una IP, despliega el mismo `worker.js` en [Deno Deploy](https://deno.com/deploy), que es compatible.
- El plan gratuito permite 100 000 peticiones al día. Una hora de directo son unas 900, así que alcanza para uso personal.

## Qué incluye

- **Inicio**: partidos en directo, «Seguir viendo», favoritos y grabaciones.
- **Directo, Películas y Series**: por carpetas, de lo más nuevo a lo más antiguo. Tiene favoritos (★) y una búsqueda que ignora los acentos y encuentra canales, partidos y programas de la guía.
- **Guía de programación (EPG)**:
  - muestra qué echan ahora y después, con ficha, imagen y sinopsis;
  - la guía de los canales españoles se actualiza cada día de forma automática;
  - en **Ajustes** se puede desactivar.
- **Agenda deportiva**: partidos de los próximos días con los canales que los emiten. Puedes seguir a tus equipos, pedir un aviso al empezar o grabarlos.
- **Canales de respaldo**: si un canal se corta, la app pasa sola a otra versión del mismo (FHD, HD, SD…).
- **Zapping**: con ▲▼ del mando o deslizando el dedo. El piloto inferior muestra el programa, y «+ info» la sinopsis.
- **Mosaico**: vista previa de varios canales con una sola conexión.
- **Contenido adulto**: oculto por defecto. Para verlo hay que poner un PIN que creas la primera vez.
- **Buffer adaptativo**: si un canal se corta a menudo, la app guarda más vídeo por adelantado. Se ajusta en Ajustes.

En el Tesla, el vídeo solo se reproduce con el coche en *Park*.

## Opcional: grabador y sincronización con una Raspberry Pi

[`recorder/recorder.py`](recorder/recorder.py) convierte una Raspberry Pi, o cualquier Linux encendido en casa, en un grabador. Con él puedes:

- **Grabar** programas y partidos en un disco USB aunque no haya nada más encendido. Si un canal se corta, pasa a los canales de respaldo. Se puede ver una grabación desde el principio mientras se está grabando. La app avisa de los cortes de las grabaciones.
- **Sincronizar** favoritos, equipos, avisos, «Seguir viendo» y ajustes entre todos los dispositivos que abran la app desde la Pi.

Solo funciona abriendo la app desde la Pi, en la red de casa (`http://<ip-de-la-pi>:8090`). Desde `https://lusob.github.io` el navegador bloquea las llamadas a un equipo `http://` de la red local.

### Instalación

Necesitas `python3` (solo usa la librería estándar) y `ffmpeg`:

```sh
sudo apt install python3 ffmpeg
mkdir -p ~/iptv-rec
cp recorder.py ~/iptv-rec/
```

Monta un disco USB (por ejemplo en `/mnt/pendrive`, con `nofail` en `/etc/fstab`). Por defecto las grabaciones van a `/mnt/pendrive/iptv`, y el grabador se niega a grabar si el disco no está montado, para no llenar la tarjeta SD.

Para que arranque solo, crea `/etc/systemd/system/iptv-rec.service` cambiando `<usuario>` por tu usuario:

```ini
[Unit]
Description=IPTV recorder
Wants=network-online.target
After=network-online.target

[Service]
User=<usuario>
ExecStart=/usr/bin/python3 /home/<usuario>/iptv-rec/recorder.py --port 8090 --data /mnt/pendrive/iptv
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now iptv-rec
journalctl -u iptv-rec -f      # registro
```

Después abre `http://<ip-de-la-pi>:8090` en cualquier dispositivo de casa y entra con tu cuenta. Aparecerán la carpeta **⏺ Grabaciones** y los botones **Grabar** en la guía, la agenda y el reproductor.

Opciones del grabador:

| Opción | Para qué sirve | Por defecto |
|---|---|---|
| `--port` | Puerto | `8090` |
| `--data` | Carpeta de las grabaciones | `/mnt/pendrive/iptv` |
| `--require-mount` | Punto de montaje que debe existir para grabar (`''` para no comprobarlo) | `/mnt/pendrive` |
| `--conf` | Fichero donde se guardan las credenciales, con permisos 600 | `~/iptv-rec/conf.json` |
| `--app` | De dónde descarga la app | `https://lusob.github.io/iptv/` |

**Cuentas con una sola conexión:** mientras la Pi graba, tu cuenta ya está usando su conexión. La app avisa antes de abrir un canal y te ofrece ver la grabación o detenerla.

Si `ffmpeg` falla al arrancar en Raspberry Pi OS por `libblas.so.3`, añade al servicio:

```ini
Environment=LD_LIBRARY_PATH=/usr/lib/aarch64-linux-gnu/blas:/usr/lib/aarch64-linux-gnu/lapack
```

## Desarrollo

No hace falta compilar nada:

```sh
python3 -m http.server 8000      # http://localhost:8000
```

Los ficheros son:
- `index.html`, `css/`, `js/`: la app;
- `proxy/`: el proxy CORS;
- `recorder/`: el grabador.

Al publicar cambios, sube el número de `?v=` de los imports y `VERSION` en `js/app.js`. Si no, algunos navegadores (el del Tesla, por ejemplo) siguen usando la versión antigua guardada en caché.
