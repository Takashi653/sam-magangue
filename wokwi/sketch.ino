/*
  SAM-Magangué · Nodo de medición E1 (prototipo en Wokwi)
  Proyecto de Ingeniería I · UNAD · Grupo 62 · William Enrique Paba Ruenes

  Arduino Uno + sensor ultrasónico HC-SR04 + DHT22 (temperatura del aire).
  El sensor se monta en el puente o muelle a la cota H_MONTAJE y mide la distancia
  hasta la superficie del agua. Nivel del río: h = H_MONTAJE - d.

  Bloques de la Etapa 3 que implementa:
    E1  lectura del nivel h(t)
    P1  validación: mediana de 5 ecos, rango físico y salto máximo
    P2  tasa de cambio dh/dt, tiempo hasta cada umbral y semáforo local
    S   LEDs verde/amarillo/naranja/rojo, zumbador y trama JSON por Serial
        (la trama es la que recibe la API de ingesta del simulador web)

  En Wokwi, haga clic en el HC-SR04 y mueva el control "distance" para simular
  la creciente. Cada cm del simulador representa 1 cm real (rango útil 2–400 cm),
  por eso el sensor se monta a 11,0 m: cubre niveles de 7,0 m a 10,98 m,
  que incluyen las cotas de alerta de 8, 9 y 10 m.
*/
#include <DHT.h>

// ---------- Pines ----------
const uint8_t PIN_TRIG = 9;
const uint8_t PIN_ECHO = 10;
const uint8_t PIN_DHT  = 7;
const uint8_t LED_VERDE = 2, LED_AMARILLO = 3, LED_NARANJA = 4, LED_ROJO = 5;
const uint8_t PIN_BUZZER = 6;

// ---------- Parámetros de diseño (Tabla 4, Etapa 3) ----------
const float H_MONTAJE = 11.00;               // cota del sensor [m]
const float U_AM = 8.0, U_NA = 9.0, U_RO = 10.0; // umbrales [m]
const float T_MIN_H = 6.0;                   // anticipación mínima [h]
const float SALTO_MAX = 0.50;                // salto máximo entre lecturas [m]
const float HISTERESIS = 0.15;               // [m]

// En la estación real se lee cada 10 min. En simulación cada 2 s,
// y cada lectura representa 10 min de tiempo del río (factor de escala).
const unsigned long PERIODO_MS = 2000;
const float MIN_POR_LECTURA = 10.0;

DHT dht(PIN_DHT, DHT22);

const uint8_t VENTANA = 6;                   // 6 lecturas = 1 h
float historial[VENTANA];
uint8_t nHist = 0;
float ultimoValido = NAN;
uint8_t nivelAlerta = 0;                     // 0 verde, 1 amarilla, 2 naranja, 3 roja
uint8_t cuentaBajada = 0;
unsigned long nLectura = 0, nDescartes = 0;

// Una medición: duración del eco en microsegundos
unsigned long medirEcoUs() {
  digitalWrite(PIN_TRIG, LOW);  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH); delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  return pulseIn(PIN_ECHO, HIGH, 30000UL);   // 0 si no hay eco (> ~5 m)
}

// Mediana de 5 ecos para descartar rebotes (P1)
unsigned long medianaEco() {
  unsigned long v[5];
  for (uint8_t i = 0; i < 5; i++) { v[i] = medirEcoUs(); delay(60); }
  for (uint8_t i = 1; i < 5; i++) {          // ordenamiento por inserción
    unsigned long x = v[i]; int8_t j = i - 1;
    while (j >= 0 && v[j] > x) { v[j + 1] = v[j]; j--; }
    v[j + 1] = x;
  }
  return v[2];
}

void semaforo(uint8_t n) {
  digitalWrite(LED_VERDE,    n == 0);
  digitalWrite(LED_AMARILLO, n == 1);
  digitalWrite(LED_NARANJA,  n == 2);
  digitalWrite(LED_ROJO,     n == 3);
  if (n >= 2) tone(PIN_BUZZER, n == 3 ? 1800 : 1200, n == 3 ? 400 : 150);
}

float horasHasta(float u, float h, float v) {
  if (h >= u) return 0;
  if (v <= 0) return INFINITY;
  return (u - h) / v;
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_TRIG, OUTPUT); pinMode(PIN_ECHO, INPUT);
  pinMode(LED_VERDE, OUTPUT); pinMode(LED_AMARILLO, OUTPUT);
  pinMode(LED_NARANJA, OUTPUT); pinMode(LED_ROJO, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  dht.begin();
  semaforo(0);
  Serial.println(F("SAM-Magangue nodo E1 listo. Montaje a 11,00 m. Umbrales 8/9/10 m."));
}

void loop() {
  static unsigned long t0 = 0;
  if (millis() - t0 < PERIODO_MS) return;
  t0 = millis();
  nLectura++;

  // Temperatura del aire para corregir la velocidad del sonido
  float T = dht.readTemperature();
  if (isnan(T)) T = 30.0;                    // valor típico de Magangué si falla el DHT22
  float c = 331.3 + 0.606 * T;               // [m/s]

  unsigned long eco = medianaEco();
  float d = (eco > 0) ? (c * eco * 1e-6) / 2.0 : NAN;   // distancia [m]
  float hCrudo = isnan(d) ? NAN : H_MONTAJE - d;

  // P1: validación
  const char* estado = "ok";
  bool valido = true;
  if (isnan(hCrudo))                          { valido = false; estado = "sin_eco"; }
  else if (hCrudo < 0 || hCrudo > 15)         { valido = false; estado = "fuera_de_rango"; }
  else if (!isnan(ultimoValido) && fabs(hCrudo - ultimoValido) > SALTO_MAX)
                                              { valido = false; estado = "salto"; }
  if (valido) ultimoValido = hCrudo; else nDescartes++;
  float h = ultimoValido;

  // P2: tasa de cambio en la última hora (6 lecturas)
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
  else if (objetivo < nivelAlerta) {
    float umbralActual = (nivelAlerta == 1) ? U_AM : (nivelAlerta == 2) ? U_NA : U_RO;
    if (h < umbralActual - HISTERESIS) { if (++cuentaBajada >= 3) { nivelAlerta = objetivo; cuentaBajada = 0; } }
    else cuentaBajada = 0;
  }
  semaforo(nivelAlerta);

  // S: trama JSON hacia la API de ingesta (P1 del servidor)
  const char* NOM[] = {"verde", "amarilla", "naranja", "roja"};
  Serial.print(F("{\"n\":"));      Serial.print(nLectura);
  Serial.print(F(",\"eco_us\":")); Serial.print(eco);
  Serial.print(F(",\"T_C\":"));    Serial.print(T, 1);
  Serial.print(F(",\"c_ms\":"));   Serial.print(c, 1);
  Serial.print(F(",\"d_m\":"));    if (isnan(d)) Serial.print(F("null")); else Serial.print(d, 3);
  Serial.print(F(",\"h_m\":"));    if (isnan(h)) Serial.print(F("null")); else Serial.print(h, 3);
  Serial.print(F(",\"dhdt_mh\":"));Serial.print(dhdt, 3);
  Serial.print(F(",\"t_naranja_h\":")); if (isinf(tNa)) Serial.print(F("null")); else Serial.print(tNa, 1);
  Serial.print(F(",\"estado\":\"")); Serial.print(estado);
  Serial.print(F("\",\"alerta\":\"")); Serial.print(NOM[nivelAlerta]);
  Serial.print(F("\",\"descartes\":")); Serial.print(nDescartes);
  Serial.println(F("}"));
}
