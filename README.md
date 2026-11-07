# SAM-Magangué · Prototipo de baja fidelidad

Sistema de Alerta Multicanal ante crecientes del río Magdalena (Magangué, Bolívar).
Proyecto de Ingeniería I · UNAD · Grupo 62 · William Enrique Paba Ruenes · Etapa 4.

**Demo:** https://takashi653.github.io/sam-magangue/
Cuenta demo: usuario `demo123` · contraseña `demo1234`, o cree una cuenta ciudadana con **Registrarse**.

## Estructura
| Archivo | Contenido |
|---|---|
| `index.html`, `landing.css`, `landing.js` | Página de inicio con regla limnimétrica animada, inicio de sesión y registro |
| `wokwi/sketch.ino`, `wokwi/diagram.json` | Nodo de medición E1: Arduino Uno + HC-SR04 + DHT22, LEDs y zumbador ([proyecto en Wokwi](https://wokwi.com/projects/479990588756527105)) |
| `app.html`, `styles.css`, `app.js` | Simulador: panel institucional, sensor E1 (Arduino + HC-SR04), bitácora en vivo, notificaciones, reportes ciudadanos, banco de pruebas Monte Carlo, ecosistema y configuración |

HTML, CSS y JavaScript sin servidor ni compilación (React 18 desde CDN en el simulador).
Las cuentas se guardan solo en el navegador (localStorage). Datos simulados con fines académicos.
