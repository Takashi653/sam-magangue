/*
  SAM-Magangué · Nodo de medición E1 conectado (ESP32 + HC-SR04) en Wokwi
  Proyecto de Ingeniería I · UNAD · Grupo 62 · William Enrique Paba Ruenes

  El nodo mide el nivel del río con el sensor ultrasónico y PUBLICA cada lectura
  por WiFi (MQTT). La página del prototipo se suscribe al mismo tema y usa esas
  lecturas como entrada E1: valida (P1), calcula dh/dt y clasifica (P2) y difunde
  la alerta (P4). Así el circuito y la página quedan conectados.

  Flujo:  HC-SR04 -> ESP32 -> WiFi "Wokwi-GUEST" -> broker MQTT (broker.hivemq.com)
          -> página web (MQTT sobre WebSocket) -> motor de reglas del prototipo

  Para simular la creciente: haga clic en el HC-SR04 y mueva "distance".
  Cada lectura (cada 2 s) representa 10 min del río.
*/
#include <WiFi.h>
#include <PubSubClient.h>
#include <DHT.h>

// ---------- Red y MQTT ----------
const char* WIFI_SSID  = "Wokwi-GUEST";
const char* WIFI_PASS  = "";
const char* MQTT_HOST  = "broker.hivemq.com";
const uint16_t MQTT_PORT = 1883;
const char* MQTT_TEMA  = "unad-g62/sam-magangue/e1";   // la página escucha este tema

// ---------- Pines ----------
const uint8_t PIN_TRIG = 5;
const uint8_t PIN_ECHO = 18;
const uint8_t PIN_DHT  = 15;
const uint8_t LED_VERDE = 25, LED_AMARILLO = 26, LED_NARANJA = 27, LED_ROJO = 14;
const uint8_t PIN_BUZZER = 13;

// ---------- Parámetros de diseño (Etapa 3) ----------
const float H_MONTAJE = 11.00;                   // cota del sensor [m]
const float U_AM = 8.0, U_NA = 9.0, U_RO = 10.0; // umbrales [m]
const float T_MIN_H = 6.0;                       // anticipación mínima [h]
const float SALTO_MAX = 0.50;                    // salto máximo entre lecturas [m]
const float HISTERESIS = 0.15;                   // [m]
const unsigned long PERIODO_MS = 2000;           // 2 s simulados = 10 min del río
const float MIN_POR_LECTURA = 10.0;

DHT dht(PIN_DHT, DHT22);
WiFiClient red;
PubSubClient mqtt(red);

const uint8_t VENTANA = 6;                       // 6 lecturas = 1 h
float historial[VENTANA];
uint8_t nHist = 0, nivelAlerta = 0, cuentaBajada = 0, nSaltos = 0;
float ultimoValido = NAN, candidato = NAN;
unsigned long nLectura = 0, nDescartes = 0;
char idCliente[32];

unsigned long medirEcoUs() {
  digitalWrite(PIN_TRIG, LOW);  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH); delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  return pulseIn(PIN_ECHO, HIGH, 30000UL);       // 0 si no hay eco
}

unsigned long medianaEco() {                     // mediana de 5 ecos (P1)
  unsigned long v[5];
  for (uint8_t i = 0; i < 5; i++) { v[i] = medirEcoUs(); delay(60); }
  for (uint8_t i = 1; i < 5; i++) {
    unsigned long x = v[i]; int8_t j = i - 1;
    while (j >= 0 && v[j] > x) { v[j + 1] = v[j]; j--; }
    v[j + 1] = x;
  }
  return v[2];
}

void semaforo(uint8_t n) {
  digitalWrite(LED_VERDE, n == 0);   digitalWrite(LED_AMARILLO, n == 1);
  digitalWrite(LED_NARANJA, n == 2); digitalWrite(LED_ROJO, n == 3);
  if (n >= 2) tone(PIN_BUZZER, n == 3 ? 1800 : 1200, n == 3 ? 400 : 150);
}

float horasHasta(float u, float h, float v) {
  if (h >= u) return 0;
  if (v <= 0) return INFINITY;
  return (u - h) / v;
}

void conectarWiFi() {
  Serial.print("Conectando a WiFi");
  WiFi.begin(WIFI_SSID, WIFI_PASS, 6);
  while (WiFi.status() != WL_CONNECTED) { delay(250); Serial.print("."); }
  Serial.println(" conectado.");
}

void conectarMQTT() {
  while (!mqtt.connected()) {
    Serial.print("Conectando al broker MQTT... ");
    if (mqtt.connect(idCliente)) Serial.println("listo.");
    else { Serial.print("error "); Serial.println(mqtt.state()); delay(1000); }
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_TRIG, OUTPUT); pinMode(PIN_ECHO, INPUT);
  pinMode(LED_VERDE, OUTPUT); pinMode(LED_AMARILLO, OUTPUT);
  pinMode(LED_NARANJA, OUTPUT); pinMode(LED_ROJO, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  dht.begin();
  semaforo(0);
  snprintf(idCliente, sizeof(idCliente), "sam-e1-%04lx", (unsigned long)(esp_random() & 0xFFFF));
  conectarWiFi();
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(512);
  conectarMQTT();
  Serial.println("SAM-Magangue nodo E1 (ESP32) listo. Publicando en " + String(MQTT_TEMA));
}

void loop() {
  if (!mqtt.connected()) conectarMQTT();
  mqtt.loop();

  static unsigned long t0 = 0;
  if (millis() - t0 < PERIODO_MS) return;
  t0 = millis();
  nLectura++;

  // E1: medición
  float T = dht.readTemperature();
  if (isnan(T)) T = 30.0;
  float c = 331.3 + 0.606 * T;                   // velocidad del sonido [m/s]
  unsigned long eco = medianaEco();
  float d = (eco > 0) ? (c * eco * 1e-6) / 2.0 : NAN;
  float hCrudo = isnan(d) ? NAN : H_MONTAJE - d;

  // P1 local (para el semáforo del nodo)
  const char* estado = "ok";
  bool valido = true;
  if (isnan(hCrudo))                  { valido = false; estado = "sin_eco"; }
  else if (hCrudo < 0 || hCrudo > 15) { valido = false; estado = "fuera_de_rango"; }
  else if (!isnan(ultimoValido) && fabs(hCrudo - ultimoValido) > SALTO_MAX) {
    if (!isnan(candidato) && fabs(hCrudo - candidato) <= SALTO_MAX && ++nSaltos >= 3) { nSaltos = 0; estado = "resincronizado"; }
    else { if (isnan(candidato) || fabs(hCrudo - candidato) > SALTO_MAX) nSaltos = 1; candidato = hCrudo; valido = false; estado = "salto"; }
  }
  if (valido) { ultimoValido = hCrudo; candidato = NAN; if (strcmp(estado, "ok") == 0) nSaltos = 0; } else nDescartes++;
  float h = ultimoValido;

  // P2 local
  float dhdt = 0;
  if (!isnan(h)) {
    if (nHist == VENTANA) { for (uint8_t i = 1; i < VENTANA; i++) historial[i - 1] = historial[i]; nHist--; }
    historial[nHist++] = h;
    if (nHist == VENTANA) dhdt = (h - historial[0]) * 60.0 / (MIN_POR_LECTURA * (VENTANA - 1));
  }
  float tAm = horasHasta(U_AM, h, dhdt), tNa = horasHasta(U_NA, h, dhdt), tRo = horasHasta(U_RO, h, dhdt);
  uint8_t objetivo = 0;
  if (h >= U_AM || tAm <= T_MIN_H) objetivo = 1;
  if (h >= U_NA || tNa <= T_MIN_H) objetivo = 2;
  if (h >= U_RO || tRo <= T_MIN_H) objetivo = 3;
  if (objetivo > nivelAlerta) { nivelAlerta = objetivo; cuentaBajada = 0; }
  else if (objetivo < nivelAlerta && dhdt <= 0) {
    float umbral = (nivelAlerta == 1) ? U_AM : (nivelAlerta == 2) ? U_NA : U_RO;
    if (h < umbral - HISTERESIS) { if (++cuentaBajada >= 3) { nivelAlerta = objetivo; cuentaBajada = 0; } }
    else cuentaBajada = 0;
  }
  semaforo(nivelAlerta);

  // S: trama JSON -> Serial y MQTT (la página usa h_crudo como entrada E1)
  const char* NOM[] = {"verde", "amarilla", "naranja", "roja"};
  char buf[320];
  char sd[12], sh[12], shc[12];
  if (isnan(d)) strcpy(sd, "null"); else dtostrf(d, 0, 3, sd);
  if (isnan(h)) strcpy(sh, "null"); else dtostrf(h, 0, 3, sh);
  if (isnan(hCrudo)) strcpy(shc, "null"); else dtostrf(hCrudo, 0, 3, shc);
  snprintf(buf, sizeof(buf),
    "{\"n\":%lu,\"eco_us\":%lu,\"T_C\":%.1f,\"c_ms\":%.1f,\"d_m\":%s,\"h_crudo\":%s,\"h_m\":%s,"
    "\"dhdt_mh\":%.3f,\"estado\":\"%s\",\"alerta_nodo\":\"%s\",\"descartes\":%lu}",
    nLectura, eco, T, c, sd, shc, sh, dhdt, estado, NOM[nivelAlerta], nDescartes);
  Serial.println(buf);
  mqtt.publish(MQTT_TEMA, buf);
}
