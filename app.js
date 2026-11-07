/* SAM-Magangué · prototipo de baja fidelidad · JavaScript (React 18 vía CDN, sin compilación en el navegador) */
const {
  useState,
  useEffect,
  useMemo,
  useRef
} = React;

/* ===================== MOTOR DE SIMULACIÓN (independiente de la interfaz) ===================== */
// Generador pseudoaleatorio con semilla (resultados reproducibles)
function rng(seed) {
  return function () {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function gauss(r) {
  let u = 0;
  while (!u) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}
const DT_MIN = 10; // una lectura cada 10 min (Tabla 4, Etapa 3)
const N_STEPS = 72 * 6 + 1; // 72 horas de simulación
const NIVELES = ["verde", "amarilla", "naranja", "roja"];
const TXT = {
  verde: "Normal",
  amarilla: "Alerta amarilla",
  naranja: "Alerta naranja",
  roja: "Alerta roja"
};
const ICO = {
  verde: "✔",
  amarilla: "⚠",
  naranja: "⚠",
  roja: "⛔"
};
const DEF_CFG = {
  hAm: 8.0,
  hNa: 9.0,
  hRo: 10.0,
  tmin: 6,
  confirm: 1,
  histeresis: 0.15,
  rate: 50,
  colas: "paralelo",
  pPush: 0.85,
  pSms: 0.95,
  pVoz: 0.60,
  retries: 3,
  ackWait: 300,
  sigma: 0.01,
  pFalla: 0.02
};

// Escenarios hidrológicos: tramos [hora_fin, tasa m/h]
const ESCENARIOS = {
  creciente: {
    nombre: "Creciente (llega a roja)",
    h0: 7.40,
    tramos: [[12, 0.02], [48, 0.06], [60, 0.03], [72, -0.02]]
  },
  falsa: {
    nombre: "Subida que se detiene",
    h0: 7.60,
    tramos: [[11, 0.09], [16, 0.01], [72, -0.03]]
  },
  normal: {
    nombre: "Nivel normal con ruido",
    h0: 6.80,
    tramos: [[72, 0]],
    onda: 0.15
  }
};

// E1: serie de nivel del río con ruido y fallas de sensor
function generarSerie(escKey, cfg, seed, jitter = 0) {
  const r = rng(seed),
    e = ESCENARIOS[escKey];
  const f = 1 + jitter * (r() * 2 - 1),
    h0 = e.h0 + jitter * 0.5 * (r() * 2 - 1);
  const real = [],
    obs = [];
  let h = h0;
  for (let i = 0; i < N_STEPS; i++) {
    const t = i * DT_MIN / 60;
    if (i > 0) {
      const tr = e.tramos.find(x => t <= x[0]) || e.tramos[e.tramos.length - 1];
      h += tr[1] * f * DT_MIN / 60;
    }
    const hv = h + (e.onda ? e.onda * Math.sin(2 * Math.PI * t / 24) : 0);
    real.push(hv);
    let o = hv + gauss(r) * cfg.sigma;
    const u = r();
    if (u < cfg.pFalla / 3) o = null; // sensor sin dato
    else if (u < 2 * cfg.pFalla / 3) o = -1; // valor fuera de rango
    else if (u < cfg.pFalla) o = hv + 3 + r() * 5; // pico espurio
    obs.push(o == null ? null : Math.round(o * 1000) / 1000);
  }
  return {
    real,
    obs
  };
}

// P1 + P2: validación, tasa de cambio, tiempo a umbral y clasificación con histéresis
function procesar(obs, cfg) {
  const out = [];
  let ultimo = null,
    nivel = 0,
    cand = 0,
    candCnt = 0,
    bajaCnt = 0;
  const val = [];
  const U = [cfg.hAm, cfg.hNa, cfg.hRo];
  for (let i = 0; i < obs.length; i++) {
    const o = obs[i];
    let valido = true,
      motivo = "";
    if (o == null) {
      valido = false;
      motivo = "sin dato";
    } else if (o < 0 || o > 15) {
      valido = false;
      motivo = "fuera de rango [0,15] m";
    } else if (ultimo != null && Math.abs(o - ultimo) > 0.5) {
      valido = false;
      motivo = "salto > 0,5 m en 10 min";
    }
    if (valido) ultimo = o;
    val.push(ultimo);
    const h = ultimo;
    const j = Math.max(0, i - 6); // ventana de 1 h (6 lecturas)
    const dhdt = i >= 6 && h != null && val[j] != null ? (h - val[j]) / 1 : 0;
    const tU = U.map(u => h >= u ? 0 : dhdt > 0 ? (u - h) / dhdt : Infinity);
    let obj = 0;
    for (let k = 0; k < 3; k++) {
      if (h >= U[k] || tU[k] <= cfg.tmin) obj = k + 1;
    }
    // confirmación de subida (n lecturas consecutivas) e histéresis de bajada
    if (obj > nivel) {
      if (obj === cand) candCnt++;else {
        cand = obj;
        candCnt = 1;
      }
      if (candCnt >= cfg.confirm) {
        nivel = obj;
        candCnt = 0;
        bajaCnt = 0;
      }
    } else {
      cand = 0;
      candCnt = 0;
    }
    if (obj < nivel) {
      const lim = U[nivel - 1] - cfg.histeresis;
      const tr = tU[nivel - 1];
      if (h < lim && tr > cfg.tmin) {
        bajaCnt++;
        if (bajaCnt >= 3) {
          nivel = obj;
          bajaCnt = 0;
        }
      } else bajaCnt = 0;
    }
    out.push({
      i,
      t: i * DT_MIN / 60,
      obs: o,
      valido,
      motivo,
      h,
      dhdt,
      tAm: tU[0],
      tNa: tU[1],
      tRo: tU[2],
      nivel
    });
  }
  return out;
}

// Población por barrio (Np = 40 000; H = 10 526 hogares, Etapa 3)
const BARRIOS = [{
  id: "gir",
  nombre: "Girardot",
  hogares: 4210
}, {
  id: "nv",
  nombre: "Nueva Venecia",
  hogares: 3580
}, {
  id: "bar",
  nombre: "Baracoa",
  hogares: 1500
}, {
  id: "sc",
  nombre: "Santa Coita",
  hogares: 1236
}];
const PERFILES = [{
  id: "smart",
  p: 0.68,
  canales: ["push", "sms"],
  retry: ["push", "sms", "voz"]
}, {
  id: "basico",
  p: 0.27,
  canales: ["sms", "voz"],
  retry: ["sms", "voz"]
}, {
  id: "sin",
  p: 0.05,
  canales: ["voz"],
  retry: ["voz"]
}];

// P4: gestor de notificaciones con colas, acuse y reintentos
function simularDifusion(cfg, seed, nivel = "naranja") {
  const r = rng(seed);
  const H = BARRIOS.reduce((a, b) => a + b.hogares, 0);
  const P = {
    push: cfg.pPush,
    sms: cfg.pSms,
    voz: cfg.pVoz
  };
  const DL = {
    push: [2, 30],
    sms: [10, 120],
    voz: [20, 90]
  };
  const tIngesta = 10 + r() * 50,
    tEval = 0.2 + r() * 4.8,
    tEnc = r() * 5; // presupuesto de latencia (Cálculo 6)
  const t0 = tIngesta + tEval + tEnc;
  const hog = [];
  for (let k = 0; k < H; k++) {
    const u = r();
    let acc = 0,
      pf = PERFILES[2];
    for (const p of PERFILES) {
      acc += p.p;
      if (u < acc) {
        pf = p;
        break;
      }
    }
    hog.push({
      pf,
      alc: Infinity,
      canal: null
    });
  }
  const lat = {
    push: [],
    sms: [],
    voz: []
  };
  let msgs = 0,
    ultimoEnvio = 0;
  const porRonda = [];
  for (let ronda = 0; ronda <= cfg.retries; ronda++) {
    const base = ronda * cfg.ackWait;
    const pos = {
      push: 0,
      sms: 0,
      voz: 0,
      all: 0
    };
    const pend = hog.filter(x => x.alc === Infinity);
    if (!pend.length) break;
    for (const x of pend) {
      const cs = ronda === 0 ? x.pf.canales : x.pf.retry;
      for (const c of cs) {
        const q = cfg.colas === "paralelo" ? pos[c]++ : pos.all++;
        const tEnvio = t0 + base + q / cfg.rate;
        msgs++;
        if (ronda === 0) ultimoEnvio = Math.max(ultimoEnvio, tEnvio);
        if (r() < P[c]) {
          const d = DL[c][0] + r() * (DL[c][1] - DL[c][0]);
          const tl = tEnvio + d;
          if (ronda === 0) lat[c].push(tl);
          if (tl < x.alc) {
            x.alc = tl;
            x.canal = c;
          }
        }
      }
    }
    porRonda.push(hog.filter(x => x.alc < Infinity).length / H);
  }
  const alc = hog.filter(x => x.alc < Infinity);
  const pct = (a, p) => {
    if (!a.length) return NaN;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };
  const t5 = alc.map(x => x.alc);
  return {
    H,
    msgs,
    t0,
    difusion: ultimoEnvio,
    entrega1: porRonda[0],
    entregaFinal: alc.length / H,
    porRonda,
    pushP50: pct(lat.push, 0.5),
    pushP95: pct(lat.push, 0.95),
    smsP50: pct(lat.sms, 0.5),
    smsP95: pct(lat.sms, 0.95),
    alcanzados5min: t5.filter(t => t <= 300).length / H,
    porCanal: {
      push: alc.filter(x => x.canal === "push").length,
      sms: alc.filter(x => x.canal === "sms").length,
      voz: alc.filter(x => x.canal === "voz").length
    },
    porPerfil: PERFILES.map(p => {
      const g = hog.filter(x => x.pf === p);
      return {
        id: p.id,
        n: g.length,
        alc: g.filter(x => x.alc < Infinity).length / g.length
      };
    })
  };
}

// Evaluación de una corrida completa (detección + anticipación + falsos positivos)
function evaluarCorrida(escKey, cfg, seed, jitter) {
  const {
    real,
    obs
  } = generarSerie(escKey, cfg, seed, jitter);
  const res = procesar(obs, cfg);
  const cruce = u => {
    const k = real.findIndex(h => h >= u);
    return k < 0 ? null : k * DT_MIN / 60;
  };
  const primera = n => {
    const k = res.findIndex(x => x.nivel >= n);
    return k < 0 ? null : k * DT_MIN / 60;
  };
  const tc9 = cruce(cfg.hNa),
    ta9 = primera(2),
    tc10 = cruce(cfg.hRo),
    ta10 = primera(3);
  const invalidas = res.filter(x => !x.valido).length;
  const falsasLect = res.filter((x, i) => x.valido && false).length;
  const maxReal = Math.max(...real);
  return {
    esc: escKey,
    seed,
    maxReal,
    tc9,
    ta9,
    antic9: tc9 != null && ta9 != null ? tc9 - ta9 : null,
    tc10,
    ta10,
    antic10: tc10 != null && ta10 != null ? tc10 - ta10 : null,
    fpNaranja: ta9 != null && tc9 == null,
    fnNaranja: tc9 != null && ta9 == null,
    invalidas,
    filtradas: invalidas,
    errMax: Math.max(...res.map((x, i) => x.h == null ? 0 : Math.abs(x.h - real[i])))
  };
}

/* ===================== COMPONENTES DE INTERFAZ ===================== */
const fmt = (x, d = 2) => x == null || !isFinite(x) ? "—" : Number(x).toFixed(d).replace(".", ",");
const fmtH = x => x == null || !isFinite(x) ? "> 72 h" : fmt(x, 1) + " h";
function Grafico({
  serie,
  real,
  cfg,
  hasta,
  alto = 230
}) {
  const W = 760,
    H = alto,
    pl = 40,
    pr = 10,
    pt = 10,
    pb = 24;
  const ys = [...real, cfg.hRo + 0.3, 6.4];
  const ymin = Math.floor(Math.min(...ys.filter(v => v != null)) * 2) / 2,
    ymax = Math.ceil(Math.max(...ys.filter(v => v != null)) * 2) / 2;
  const X = i => pl + (W - pl - pr) * i / (N_STEPS - 1),
    Y = v => pt + (H - pt - pb) * (1 - (v - ymin) / (ymax - ymin));
  const path = arr => arr.slice(0, hasta + 1).map((v, i) => v == null ? "" : `${i && arr[i - 1] != null ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("");
  const col = {
    1: "var(--amarilla)",
    2: "var(--naranja)",
    3: "var(--roja)"
  };
  const bandas = [];
  let ini = 0;
  for (let i = 1; i <= hasta + 1; i++) {
    if (i === hasta + 1 || serie[i].nivel !== serie[ini].nivel) {
      if (serie[ini].nivel > 0) bandas.push(/*#__PURE__*/React.createElement("rect", {
        key: ini,
        x: X(ini),
        y: pt,
        width: X(i - 1) - X(ini) + 1,
        height: H - pt - pb,
        fill: col[serie[ini].nivel],
        opacity: ".14"
      }));
      ini = i;
    }
  }
  const ticks = [];
  for (let v = ymin; v <= ymax + 1e-9; v += 0.5) ticks.push(v);
  return /*#__PURE__*/React.createElement("svg", {
    viewBox: `0 0 ${W} ${H}`,
    width: "100%",
    role: "img",
    "aria-label": "Nivel del r\xEDo en el tiempo"
  }, bandas, ticks.map(v => /*#__PURE__*/React.createElement("g", {
    key: v
  }, /*#__PURE__*/React.createElement("line", {
    x1: pl,
    x2: W - pr,
    y1: Y(v),
    y2: Y(v),
    stroke: "var(--line)"
  }), /*#__PURE__*/React.createElement("text", {
    x: pl - 4,
    y: Y(v) + 4,
    fontSize: "10",
    textAnchor: "end",
    fill: "var(--mute)"
  }, fmt(v, 1)))), [0, 12, 24, 36, 48, 60, 72].map(h => /*#__PURE__*/React.createElement("text", {
    key: h,
    x: X(h * 6),
    y: H - 6,
    fontSize: "10",
    textAnchor: "middle",
    fill: "var(--mute)"
  }, h, " h")), [[cfg.hAm, "amarilla"], [cfg.hNa, "naranja"], [cfg.hRo, "roja"]].map(([u, c]) => /*#__PURE__*/React.createElement("g", {
    key: c
  }, /*#__PURE__*/React.createElement("line", {
    x1: pl,
    x2: W - pr,
    y1: Y(u),
    y2: Y(u),
    stroke: `var(--${c})`,
    strokeDasharray: "5 4",
    strokeWidth: "1.5"
  }), /*#__PURE__*/React.createElement("text", {
    x: W - pr - 2,
    y: Y(u) - 3,
    fontSize: "10",
    textAnchor: "end",
    fill: `var(--${c})`
  }, c, " ", fmt(u, 1), " m"))), /*#__PURE__*/React.createElement("path", {
    d: path(real),
    fill: "none",
    stroke: "var(--mute)",
    strokeWidth: "1",
    strokeDasharray: "2 3"
  }), /*#__PURE__*/React.createElement("path", {
    d: path(serie.map(s => s.h)),
    fill: "none",
    stroke: "var(--pri2)",
    strokeWidth: "2.2"
  }), serie.slice(0, hasta + 1).map((s, i) => !s.valido && /*#__PURE__*/React.createElement("circle", {
    key: i,
    cx: X(i),
    cy: pt + 6,
    r: "3",
    fill: "var(--roja)"
  }, /*#__PURE__*/React.createElement("title", null, "Lectura descartada: ", s.motivo))), /*#__PURE__*/React.createElement("line", {
    x1: X(hasta),
    x2: X(hasta),
    y1: pt,
    y2: H - pb,
    stroke: "var(--ink)",
    strokeWidth: ".8"
  }));
}
function Mapa({
  nivel,
  barriosAfect
}) {
  const c = {
    0: "#7cb87f",
    1: "#f2c94c",
    2: "#f2994a",
    3: "#eb5757"
  };
  const B = [{
    id: "gir",
    x: 250,
    y: 70,
    w: 150,
    h: 70
  }, {
    id: "nv",
    x: 420,
    y: 80,
    w: 150,
    h: 65
  }, {
    id: "bar",
    x: 300,
    y: 160,
    w: 130,
    h: 60
  }, {
    id: "sc",
    x: 120,
    y: 170,
    w: 120,
    h: 55
  }];
  return /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 640 300",
    width: "100%",
    role: "img",
    "aria-label": "Mapa esquem\xE1tico de riesgo de Magangu\xE9"
  }, /*#__PURE__*/React.createElement("rect", {
    width: "640",
    height: "300",
    fill: "var(--tierra)",
    rx: "10"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M0,22 C150,40 300,10 640,30 L640,58 C300,40 150,70 0,52Z",
    fill: "var(--rio)"
  }), /*#__PURE__*/React.createElement("text", {
    x: "20",
    y: "42",
    fontSize: "12",
    fill: "#fff",
    fontWeight: "700"
  }, "R\xEDo Magdalena \u2192"), B.map(b => {
    const n = BARRIOS.find(x => x.id === b.id);
    const lv = barriosAfect.includes(b.id) ? nivel : 0;
    return /*#__PURE__*/React.createElement("g", {
      key: b.id
    }, /*#__PURE__*/React.createElement("rect", {
      x: b.x,
      y: b.y,
      width: b.w,
      height: b.h,
      rx: "8",
      fill: c[lv],
      stroke: "#333",
      strokeOpacity: ".3"
    }), /*#__PURE__*/React.createElement("text", {
      x: b.x + b.w / 2,
      y: b.y + b.h / 2 - 4,
      textAnchor: "middle",
      fontSize: "12",
      fontWeight: "700",
      fill: "#222"
    }, n.nombre), /*#__PURE__*/React.createElement("text", {
      x: b.x + b.w / 2,
      y: b.y + b.h / 2 + 12,
      textAnchor: "middle",
      fontSize: "10.5",
      fill: "#222"
    }, n.hogares.toLocaleString("es-CO"), " hogares \xB7 ", TXT[NIVELES[lv]]));
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "560",
    cy: "250",
    r: "12",
    fill: "#1f4e79"
  }), /*#__PURE__*/React.createElement("text", {
    x: "560",
    y: "254",
    textAnchor: "middle",
    fontSize: "11",
    fill: "#fff"
  }, "PE"), /*#__PURE__*/React.createElement("text", {
    x: "560",
    y: "280",
    textAnchor: "middle",
    fontSize: "10.5",
    fill: "var(--ink)"
  }, "Punto de encuentro (zona alta)"), /*#__PURE__*/React.createElement("circle", {
    cx: "80",
    cy: "270",
    r: "12",
    fill: "#1f4e79"
  }), /*#__PURE__*/React.createElement("text", {
    x: "80",
    y: "274",
    textAnchor: "middle",
    fontSize: "11",
    fill: "#fff"
  }, "PE"), nivel >= 2 && /*#__PURE__*/React.createElement("g", {
    stroke: "#1f4e79",
    strokeWidth: "2.5",
    strokeDasharray: "7 5",
    fill: "none",
    markerEnd: "url(#fl)"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M325,140 C360,200 480,230 545,248"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M495,145 C520,190 545,220 556,236"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M365,220 C420,250 500,255 546,252"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M180,225 C150,250 110,262 94,266"
  })), /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("marker", {
    id: "fl",
    viewBox: "0 0 10 10",
    refX: "8",
    refY: "5",
    markerWidth: "6",
    markerHeight: "6",
    orient: "auto"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M0,0L10,5L0,10z",
    fill: "#1f4e79"
  }))), /*#__PURE__*/React.createElement("g", null, /*#__PURE__*/React.createElement("rect", {
    x: "196",
    y: "18",
    width: "70",
    height: "20",
    rx: "4",
    fill: "#1f4e79"
  }), /*#__PURE__*/React.createElement("text", {
    x: "231",
    y: "32",
    textAnchor: "middle",
    fontSize: "10",
    fill: "#fff"
  }, "Estaci\xF3n E1")));
}

/* Autenticación de demostración (solo en este navegador; no usar contraseñas reales) */
const DEMO = {
  usuario: "demo123",
  clave: "demo1234",
  nombre: "Operador CMGRD (demo)",
  rol: "Operador",
  barrio: "gir",
  canal: "push"
};
function leerUsuarios() {
  try {
    return JSON.parse(localStorage.getItem("sam_usuarios") || "{}");
  } catch (e) {
    return {};
  }
}
function autenticar(u, p) {
  u = (u || "").trim().toLowerCase();
  if (u === DEMO.usuario && p === DEMO.clave) return DEMO;
  const x = leerUsuarios()[u];
  return x && x.clave === p ? x : null;
}
function leerSesion() {
  try {
    return JSON.parse(localStorage.getItem("sam_sesion") || "null");
  } catch (e) {
    return null;
  }
}
function guardarSesion(s) {
  try {
    s ? localStorage.setItem("sam_sesion", JSON.stringify(s)) : localStorage.removeItem("sam_sesion");
  } catch (e) {}
}
function Login({
  onOk
}) {
  const [u, setU] = useState(""),
    [p, setP] = useState(""),
    [err, setErr] = useState("");
  const go = e => {
    e.preventDefault();
    const x = autenticar(u, p);
    if (x) {
      const {
        clave,
        ...s
      } = x;
      onOk(s);
    } else setErr("Usuario o contraseña incorrectos. Use la cuenta demo o regístrese.");
  };
  return /*#__PURE__*/React.createElement("form", {
    className: "login",
    onSubmit: go
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      marginTop: 0,
      color: "var(--pri)"
    }
  }, "SAM-Magangu\xE9"), /*#__PURE__*/React.createElement("div", {
    className: "small",
    style: {
      marginBottom: 12
    }
  }, "Sistema de Alerta Multicanal ante crecientes del r\xEDo Magdalena \xB7 Prototipo de baja fidelidad (Etapa 4)"), /*#__PURE__*/React.createElement("label", null, "Usuario"), /*#__PURE__*/React.createElement("input", {
    value: u,
    onChange: e => setU(e.target.value),
    autoComplete: "username",
    placeholder: "demo123"
  }), /*#__PURE__*/React.createElement("label", null, "Contrase\xF1a"), /*#__PURE__*/React.createElement("input", {
    type: "password",
    value: p,
    onChange: e => setP(e.target.value),
    autoComplete: "current-password",
    placeholder: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"
  }), err && /*#__PURE__*/React.createElement("div", {
    className: "no",
    style: {
      marginBottom: 8
    }
  }, err), /*#__PURE__*/React.createElement("button", {
    className: "btn",
    style: {
      width: "100%"
    }
  }, "Ingresar"), /*#__PURE__*/React.createElement("div", {
    className: "hint",
    style: {
      marginTop: 12
    }
  }, "Acceso de demostraci\xF3n \u2014 usuario: ", /*#__PURE__*/React.createElement("b", null, "demo123"), " \xB7 contrase\xF1a: ", /*#__PURE__*/React.createElement("b", null, "demo1234")), /*#__PURE__*/React.createElement("p", {
    className: "small"
  }, "\xBFNo tiene cuenta? ", /*#__PURE__*/React.createElement("a", {
    href: "index.html#registro"
  }, "Reg\xEDstrese"), " \xB7 ", /*#__PURE__*/React.createElement("a", {
    href: "index.html"
  }, "Volver al inicio")));
}
function Bitacora({
  logs
}) {
  const col = {
    info: "var(--mute)",
    falla: "var(--roja)",
    alerta: "var(--naranja)",
    envio: "var(--verde)"
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("h2", null, "Bit\xE1cora del sistema (en vivo)"), /*#__PURE__*/React.createElement("div", {
    className: "log",
    "aria-live": "polite"
  }, logs.length ? logs.slice(-60).reverse().map((l, i) => /*#__PURE__*/React.createElement("div", {
    key: i
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--mute)"
    }
  }, "[", fmt(l.t, 1).padStart(5, " "), " h]"), " ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: col[l.tipo]
    }
  }, l.bloque), " ", l.txt)) : /*#__PURE__*/React.createElement("span", {
    className: "small"
  }, "Pulse \u25B6 Simular: aqu\xED aparecer\xE1n las lecturas descartadas, los cambios de alerta y los env\xEDos autom\xE1ticos.")));
}
function MiAlerta({
  user,
  s
}) {
  if (!user || user.rol === "Operador") return null;
  const lv = NIVELES[s.nivel];
  const b = BARRIOS.find(x => x.id === user.barrio);
  return /*#__PURE__*/React.createElement("div", {
    className: "card row",
    style: {
      borderLeft: `6px solid var(--${lv})`
    }
  }, /*#__PURE__*/React.createElement("b", null, "Vista ciudadana \xB7 ", user.nombre), /*#__PURE__*/React.createElement("span", {
    className: "badge b-" + lv
  }, ICO[lv], " ", TXT[lv], " en ", b ? b.nombre : "su barrio"), /*#__PURE__*/React.createElement("span", {
    className: "small"
  }, "Canal preferido: ", user.canal.toUpperCase(), " \xB7 ", s.nivel >= 2 ? "Diríjase al punto de encuentro por la ruta marcada en el mapa." : s.nivel === 1 ? "Esté atento a nuevos avisos y prepare su kit de emergencia." : "Sin riesgo por ahora."));
}
function Panel({
  cfg,
  esc,
  setEsc,
  seed,
  setSeed,
  paso,
  setPaso,
  play,
  setPlay,
  vel,
  setVel,
  datos,
  reportes,
  logs,
  user
}) {
  const s = datos.serie[paso];
  const lv = NIVELES[s.nivel];
  const afect = s.nivel >= 1 ? BARRIOS.map(b => b.id) : [];
  const nVal = datos.serie.slice(0, paso + 1).filter(x => !x.valido).length;
  return /*#__PURE__*/React.createElement("div", {
    className: "grid",
    style: {
      gap: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card row",
    style: {
      justifyContent: "space-between"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "row"
  }, /*#__PURE__*/React.createElement("label", null, "Escenario ", /*#__PURE__*/React.createElement("select", {
    value: esc,
    onChange: e => {
      setEsc(e.target.value);
      setPaso(0);
    }
  }, Object.entries(ESCENARIOS).map(([k, v]) => /*#__PURE__*/React.createElement("option", {
    key: k,
    value: k
  }, v.nombre)))), /*#__PURE__*/React.createElement("label", null, "Semilla ", /*#__PURE__*/React.createElement("input", {
    type: "number",
    value: seed,
    onChange: e => {
      setSeed(+e.target.value || 1);
      setPaso(0);
    },
    style: {
      width: 80
    }
  })), /*#__PURE__*/React.createElement("button", {
    className: "btn",
    onClick: () => setPlay(!play)
  }, play ? "⏸ Pausar" : "▶ Simular"), /*#__PURE__*/React.createElement("button", {
    className: "btn sec",
    onClick: () => {
      setPaso(0);
      setPlay(false);
    }
  }, "\u27F2 Reiniciar"), /*#__PURE__*/React.createElement("button", {
    className: "btn sec",
    onClick: () => setPaso(Math.min(N_STEPS - 1, paso + 1))
  }, "+10 min"), /*#__PURE__*/React.createElement("label", null, "Velocidad ", /*#__PURE__*/React.createElement("select", {
    value: vel,
    onChange: e => setVel(+e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: 400
  }, "1\xD7"), /*#__PURE__*/React.createElement("option", {
    value: 120
  }, "4\xD7"), /*#__PURE__*/React.createElement("option", {
    value: 30
  }, "16\xD7")))), /*#__PURE__*/React.createElement("div", {
    className: "small"
  }, "t = ", fmt(s.t, 1), " h \xB7 lectura ", paso + 1, "/", N_STEPS)), /*#__PURE__*/React.createElement(MiAlerta, {
    user: user,
    s: s
  }), /*#__PURE__*/React.createElement("div", {
    className: "grid g4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Nivel del r\xEDo h(t) (validado)"), /*#__PURE__*/React.createElement("div", {
    className: "kpi"
  }, fmt(s.h), " m"), /*#__PURE__*/React.createElement("div", {
    className: "small"
  }, "Lectura cruda: ", s.obs == null ? "sin dato" : fmt(s.obs, 3), " ", s.valido ? "✔" : "✖ " + s.motivo)), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Tasa de cambio dh/dt (1 h)"), /*#__PURE__*/React.createElement("div", {
    className: "kpi"
  }, fmt(s.dhdt, 3), " m/h"), /*#__PURE__*/React.createElement("div", {
    className: "small"
  }, "Ecuaci\xF3n 1, Etapa 3")), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Tiempo hasta umbral (Ec. 2)"), /*#__PURE__*/React.createElement("div", {
    className: "small"
  }, "Amarillo: ", /*#__PURE__*/React.createElement("b", null, fmtH(s.tAm)), /*#__PURE__*/React.createElement("br", null), "Naranja: ", /*#__PURE__*/React.createElement("b", null, fmtH(s.tNa)), /*#__PURE__*/React.createElement("br", null), "Rojo: ", /*#__PURE__*/React.createElement("b", null, fmtH(s.tRo)))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Estado de alerta"), /*#__PURE__*/React.createElement("div", {
    style: {
      margin: "6px 0"
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "badge b-" + lv,
    "aria-live": "polite"
  }, ICO[lv], " ", TXT[lv])), /*#__PURE__*/React.createElement("div", {
    className: "small"
  }, "Lecturas descartadas: ", nVal, " \xB7 reportes ciudadanos: ", reportes.length))), /*#__PURE__*/React.createElement("div", {
    className: "grid g2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("h2", null, "E1 \u2192 P2 \xB7 Nivel del r\xEDo y clasificaci\xF3n"), /*#__PURE__*/React.createElement(Grafico, {
    serie: datos.serie,
    real: datos.real,
    cfg: cfg,
    hasta: paso
  }), /*#__PURE__*/React.createElement("div", {
    className: "small"
  }, "Azul: nivel validado \xB7 gris punteado: nivel real simulado \xB7 puntos rojos: lecturas descartadas por la validaci\xF3n (P1) \xB7 bandas: nivel de alerta emitido.")), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("h2", null, "P5 / S4 \xB7 Mapa de riesgo y rutas"), /*#__PURE__*/React.createElement(Mapa, {
    nivel: s.nivel,
    barriosAfect: afect
  }), /*#__PURE__*/React.createElement("div", {
    className: "small"
  }, "Con alerta naranja o roja se muestran las rutas de evacuaci\xF3n hacia los puntos de encuentro (PE)."))), /*#__PURE__*/React.createElement(Bitacora, {
    logs: logs
  }));
}
function Notificaciones({
  cfg,
  datos,
  paso,
  user
}) {
  const s = datos.serie[paso];
  const lv = NIVELES[s.nivel];
  const [res, setRes] = useState(null);
  const msg = s.nivel === 0 ? "Sin alertas activas. Nivel del río: " + fmt(s.h) + " m." : `SAM-Magangue: ${TXT[lv].toUpperCase()}. Rio en ${fmt(s.h, 2)} m, sube ${fmt(s.dhdt * 100, 0)} cm/h. ${s.nivel >= 2 ? "Prepare evacuacion al punto de encuentro." : "Este atento a nuevos avisos."}`.slice(0, 140);
  const hablar = () => {
    try {
      const u = new SpeechSynthesisUtterance(msg.replace("SAM-Magangue:", "Aviso de SAM Magangué."));
      u.lang = "es-CO";
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch (e) {
      alert("La síntesis de voz no está disponible en este navegador.");
    }
  };
  const correr = () => setRes(simularDifusion(cfg, 1000 + paso, lv));
  return /*#__PURE__*/React.createElement("div", {
    className: "grid g2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("h2", null, "P4 \xB7 Gestor de notificaciones (difusi\xF3n a 10 526 hogares)"), /*#__PURE__*/React.createElement("div", {
    className: "row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "badge b-" + lv
  }, ICO[lv], " ", TXT[lv]), /*#__PURE__*/React.createElement("button", {
    className: "btn",
    onClick: correr
  }, "Simular difusi\xF3n de esta alerta"), /*#__PURE__*/React.createElement("span", {
    className: "small"
  }, "Colas: ", cfg.colas, " \xB7 ", cfg.rate, " msg/s por cola \xB7 reintentos: ", cfg.retries)), res && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("table", {
    style: {
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("tbody", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Mensajes generados"), /*#__PURE__*/React.createElement("td", null, res.msgs.toLocaleString("es-CO")), /*#__PURE__*/React.createElement("th", null, "Tiempo de difusi\xF3n (ronda 1)"), /*#__PURE__*/React.createElement("td", {
    className: res.difusion <= 300 ? "ok" : "no"
  }, fmt(res.difusion, 1), " s")), /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Latencia push p50 / p95"), /*#__PURE__*/React.createElement("td", {
    className: res.pushP95 <= 100 ? "ok" : "no"
  }, fmt(res.pushP50, 0), " / ", fmt(res.pushP95, 0), " s"), /*#__PURE__*/React.createElement("th", null, "Latencia SMS p50 / p95"), /*#__PURE__*/React.createElement("td", {
    className: res.smsP95 <= 190 ? "ok" : "no"
  }, fmt(res.smsP50, 0), " / ", fmt(res.smsP95, 0), " s")), /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Entrega en 1.\xAA ronda"), /*#__PURE__*/React.createElement("td", null, fmt(res.entrega1 * 100, 2), " %"), /*#__PURE__*/React.createElement("th", null, "Entrega final (con reintentos)"), /*#__PURE__*/React.createElement("td", {
    className: res.entregaFinal >= 0.99 ? "ok" : "no"
  }, fmt(res.entregaFinal * 100, 2), " %")), /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Hogares avisados \u2264 5 min"), /*#__PURE__*/React.createElement("td", null, fmt(res.alcanzados5min * 100, 2), " %"), /*#__PURE__*/React.createElement("th", null, "Primer canal efectivo"), /*#__PURE__*/React.createElement("td", null, "push ", res.porCanal.push, " \xB7 SMS ", res.porCanal.sms, " \xB7 voz ", res.porCanal.voz)))), /*#__PURE__*/React.createElement("h3", null, "Cobertura por perfil de usuario (H-Inclusi\xF3n)"), /*#__PURE__*/React.createElement("table", null, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Perfil"), /*#__PURE__*/React.createElement("th", null, "Hogares"), /*#__PURE__*/React.createElement("th", null, "Canales"), /*#__PURE__*/React.createElement("th", null, "Entrega final"))), /*#__PURE__*/React.createElement("tbody", null, res.porPerfil.map(p => /*#__PURE__*/React.createElement("tr", {
    key: p.id
  }, /*#__PURE__*/React.createElement("td", null, {
    smart: "Smartphone",
    basico: "Celular básico",
    sin: "Sin celular (altavoz)"
  }[p.id]), /*#__PURE__*/React.createElement("td", null, p.n), /*#__PURE__*/React.createElement("td", null, PERFILES.find(x => x.id === p.id).canales.join(" + ")), /*#__PURE__*/React.createElement("td", null, fmt(p.alc * 100, 2), " %")))))), !res && /*#__PURE__*/React.createElement("p", {
    className: "small"
  }, "Pulse el bot\xF3n para ejecutar el gestor de notificaciones con la alerta del instante actual. La simulaci\xF3n usa las probabilidades de entrega por canal y el presupuesto de latencia de la Etapa 3.")), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("h2", null, "S1 \xB7 S2 \xB7 S3 \xB7 Salidas al ciudadano"), /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      alignItems: "flex-start"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "phone"
  }, /*#__PURE__*/React.createElement("div", {
    className: "small",
    style: {
      color: "#9ab"
    }
  }, "Push \xB7 App/PWA"), /*#__PURE__*/React.createElement("div", {
    className: "notif"
  }, /*#__PURE__*/React.createElement("b", null, ICO[lv], " SAM-Magangu\xE9"), /*#__PURE__*/React.createElement("br", null), msg), /*#__PURE__*/React.createElement("div", {
    className: "small",
    style: {
      color: "#9ab",
      marginTop: 12
    }
  }, "SMS (sin internet) \xB7 ", msg.length, "/140"), /*#__PURE__*/React.createElement("div", {
    className: "sms"
  }, msg)), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 150
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn",
    onClick: hablar
  }, "\uD83D\uDD0A Reproducir aviso de voz"), /*#__PURE__*/React.createElement("p", {
    className: "small"
  }, "El aviso de voz representa el canal de altavoces comunitarios y llamada autom\xE1tica para personas sin celular o con baja alfabetizaci\xF3n digital."), /*#__PURE__*/React.createElement("p", {
    className: "small"
  }, "Sesi\xF3n: ", user, ". El texto se limita a 140 caracteres y usa lenguaje sencillo; el nivel se indica con texto e \xEDcono adem\xE1s del color (WCAG 2.1 AA).")))));
}
function Reportes({
  reportes,
  setReportes,
  datos,
  paso
}) {
  const s = datos.serie[paso];
  const [b, setB] = useState("gir"),
    [h, setH] = useState(""),
    [d, setD] = useState("");
  const add = e => {
    e.preventDefault();
    const v = parseFloat(String(h).replace(",", "."));
    if (!isFinite(v)) return;
    const dif = v - s.h;
    setReportes([{
      id: Date.now(),
      t: s.t,
      barrio: b,
      h: v,
      desc: d,
      medido: s.h,
      dif,
      estado: Math.abs(dif) <= 0.3 ? "Coincide" : "Revisar sensor"
    }, ...reportes]);
    setH("");
    setD("");
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "grid g2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("h2", null, "E3 / R2 \xB7 Reportes ciudadanos y validaci\xF3n"), /*#__PURE__*/React.createElement("table", null, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "t (h)"), /*#__PURE__*/React.createElement("th", null, "Barrio"), /*#__PURE__*/React.createElement("th", null, "Nivel reportado"), /*#__PURE__*/React.createElement("th", null, "Nivel medido"), /*#__PURE__*/React.createElement("th", null, "Diferencia"), /*#__PURE__*/React.createElement("th", null, "Estado"))), /*#__PURE__*/React.createElement("tbody", null, reportes.map(r => /*#__PURE__*/React.createElement("tr", {
    key: r.id
  }, /*#__PURE__*/React.createElement("td", null, fmt(r.t, 1)), /*#__PURE__*/React.createElement("td", null, BARRIOS.find(x => x.id === r.barrio).nombre), /*#__PURE__*/React.createElement("td", null, fmt(r.h), " m"), /*#__PURE__*/React.createElement("td", null, fmt(r.medido), " m"), /*#__PURE__*/React.createElement("td", null, fmt(r.dif), " m"), /*#__PURE__*/React.createElement("td", {
    className: r.estado === "Coincide" ? "ok" : "no"
  }, r.estado))), !reportes.length && /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    colSpan: "6",
    className: "small"
  }, "A\xFAn no hay reportes.")))), /*#__PURE__*/React.createElement("p", {
    className: "small"
  }, "Regla R2: si |nivel reportado \u2212 nivel medido| > 0,30 m, el sistema marca la estaci\xF3n para revisi\xF3n t\xE9cnica.")), /*#__PURE__*/React.createElement("form", {
    className: "card",
    onSubmit: add
  }, /*#__PURE__*/React.createElement("h2", null, "Nuevo reporte"), /*#__PURE__*/React.createElement("label", null, "Barrio ", /*#__PURE__*/React.createElement("select", {
    value: b,
    onChange: e => setB(e.target.value)
  }, BARRIOS.map(x => /*#__PURE__*/React.createElement("option", {
    key: x.id,
    value: x.id
  }, x.nombre)))), /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("label", null, "Nivel observado (m) ", /*#__PURE__*/React.createElement("input", {
    type: "number",
    step: "0.01",
    value: h,
    onChange: e => setH(e.target.value),
    style: {
      width: 100
    }
  })), /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("label", null, "Descripci\xF3n", /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("textarea", {
    value: d,
    onChange: e => setD(e.target.value),
    rows: "3",
    style: {
      width: "100%"
    },
    placeholder: "Ej.: el agua lleg\xF3 al bordillo de la calle 3"
  })), /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("button", {
    className: "btn"
  }, "Enviar reporte"), /*#__PURE__*/React.createElement("p", {
    className: "small"
  }, "La foto se omite en el prototipo; en la versi\xF3n final se adjunta desde la c\xE1mara del celular.")));
}
function Experimentos({
  cfg
}) {
  const [n, setN] = useState(20),
    [jit, setJit] = useState(0.2),
    [rows, setRows] = useState(null),
    [dif, setDif] = useState(null);
  const correr = () => {
    const out = [];
    let sd = 1;
    for (const e of Object.keys(ESCENARIOS)) for (let k = 0; k < n; k++) out.push(evaluarCorrida(e, cfg, sd++, jit));
    setRows(out);
    const d = [];
    for (let k = 0; k < 10; k++) d.push(simularDifusion(cfg, 500 + k));
    setDif(d);
  };
  useEffect(() => {
    window.__SAM = {
      evaluarCorrida,
      simularDifusion,
      procesar,
      generarSerie,
      DEF_CFG,
      ESCENARIOS
    };
  }, []);
  const resumen = useMemo(() => {
    if (!rows) return null;
    const tp = rows.filter(r => r.ta9 != null && r.tc9 != null),
      fp = rows.filter(r => r.fpNaranja),
      fn = rows.filter(r => r.fnNaranja);
    const an = tp.map(r => r.antic9);
    const m = an.reduce((a, b) => a + b, 0) / an.length;
    const sd = Math.sqrt(an.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, an.length - 1));
    return {
      tp: tp.length,
      fp: fp.length,
      fn: fn.length,
      fpRate: fp.length / Math.max(1, tp.length + fp.length),
      antMed: m,
      antSd: sd,
      antMin: Math.min(...an),
      cumple6: an.filter(a => a >= cfg.tmin).length / an.length,
      errMax: Math.max(...rows.map(r => r.errMax)),
      inval: rows.reduce((a, r) => a + r.invalidas, 0)
    };
  }, [rows]);
  const csv = () => {
    const head = "escenario,semilla,max_real_m,t_cruce_9m_h,t_alerta_naranja_h,anticipacion_h,falso_positivo,lecturas_descartadas,error_max_m\n";
    const body = rows.map(r => [r.esc, r.seed, fmt(r.maxReal, 3), r.tc9 == null ? "" : r.tc9.toFixed(2), r.ta9 == null ? "" : r.ta9.toFixed(2), r.antic9 == null ? "" : r.antic9.toFixed(2), r.fpNaranja ? 1 : 0, r.invalidas, r.errMax.toFixed(3)].join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + head + body], {
      type: "text/csv"
    }));
    a.download = "matriz_experimental_SAM.csv";
    a.click();
  };
  const W = 520,
    H = 240;
  return /*#__PURE__*/React.createElement("div", {
    className: "grid",
    style: {
      gap: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card row"
  }, /*#__PURE__*/React.createElement("b", null, "Banco de pruebas (Monte Carlo)"), /*#__PURE__*/React.createElement("label", null, "Corridas por escenario ", /*#__PURE__*/React.createElement("input", {
    type: "number",
    value: n,
    min: "1",
    max: "200",
    onChange: e => setN(+e.target.value || 1),
    style: {
      width: 70
    }
  })), /*#__PURE__*/React.createElement("label", null, "Variaci\xF3n de tasas \xB1 ", /*#__PURE__*/React.createElement("input", {
    type: "number",
    step: "0.05",
    value: jit,
    onChange: e => setJit(+e.target.value),
    style: {
      width: 70
    }
  })), /*#__PURE__*/React.createElement("button", {
    className: "btn",
    onClick: correr
  }, "Ejecutar pruebas"), rows && /*#__PURE__*/React.createElement("button", {
    className: "btn sec",
    onClick: csv
  }, "\u2B07 Exportar matriz CSV"), /*#__PURE__*/React.createElement("span", {
    className: "small"
  }, "Configuraci\xF3n: confirmaci\xF3n ", cfg.confirm, " lectura(s), tmin ", cfg.tmin, " h, hist\xE9resis ", fmt(cfg.histeresis), " m")), resumen && /*#__PURE__*/React.createElement("div", {
    className: "grid g4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Anticipaci\xF3n media (alerta naranja)"), /*#__PURE__*/React.createElement("div", {
    className: "kpi"
  }, fmt(resumen.antMed), " h"), /*#__PURE__*/React.createElement("div", {
    className: "small"
  }, "DE ", fmt(resumen.antSd), " h \xB7 m\xEDn ", fmt(resumen.antMin), " h \xB7 \u2265 ", cfg.tmin, " h en ", fmt(resumen.cumple6 * 100, 1), " %")), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Falsos positivos (naranja)"), /*#__PURE__*/React.createElement("div", {
    className: "kpi " + (resumen.fpRate <= 0.05 ? "ok" : "no")
  }, fmt(resumen.fpRate * 100, 1), " %"), /*#__PURE__*/React.createElement("div", {
    className: "small"
  }, "VP ", resumen.tp, " \xB7 FP ", resumen.fp, " \xB7 FN ", resumen.fn, " \xB7 meta \u2264 5 %")), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Validaci\xF3n P1"), /*#__PURE__*/React.createElement("div", {
    className: "kpi"
  }, resumen.inval), /*#__PURE__*/React.createElement("div", {
    className: "small"
  }, "lecturas descartadas \xB7 error m\xE1x. nivel validado ", fmt(resumen.errMax, 3), " m")), dif && /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lbl"
  }, "Difusi\xF3n (10 corridas)"), /*#__PURE__*/React.createElement("div", {
    className: "kpi"
  }, fmt(Math.max(...dif.map(d => d.difusion)), 1), " s"), /*#__PURE__*/React.createElement("div", {
    className: "small"
  }, "entrega final media ", fmt(dif.reduce((a, d) => a + d.entregaFinal, 0) / dif.length * 100, 2), " % \xB7 SMS p95 ", fmt(Math.max(...dif.map(d => d.smsP95)), 0), " s"))), rows && /*#__PURE__*/React.createElement("div", {
    className: "grid g2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("h2", null, "Dispersi\xF3n: hora de cruce de 9 m vs. anticipaci\xF3n de la alerta naranja"), /*#__PURE__*/React.createElement("svg", {
    viewBox: `0 0 ${W} ${H}`,
    width: "100%"
  }, (() => {
    const pts = rows.filter(r => r.antic9 != null);
    const xs = pts.map(r => r.tc9),
      ys = pts.map(r => r.antic9);
    const x0 = Math.min(...xs) - 1,
      x1 = Math.max(...xs) + 1,
      y0 = 0,
      y1 = Math.max(8, ...ys) + 0.5;
    const X = v => 40 + (W - 50) * (v - x0) / (x1 - x0),
      Y = v => 10 + (H - 40) * (1 - (v - y0) / (y1 - y0));
    return /*#__PURE__*/React.createElement("g", null, /*#__PURE__*/React.createElement("line", {
      x1: "40",
      x2: W - 10,
      y1: Y(cfg.tmin),
      y2: Y(cfg.tmin),
      stroke: "var(--naranja)",
      strokeDasharray: "5 4"
    }), /*#__PURE__*/React.createElement("text", {
      x: W - 12,
      y: Y(cfg.tmin) - 4,
      textAnchor: "end",
      fontSize: "10",
      fill: "var(--naranja)"
    }, "meta ", cfg.tmin, " h"), [0, 2, 4, 6, 8].map(v => /*#__PURE__*/React.createElement("text", {
      key: v,
      x: "34",
      y: Y(v) + 4,
      fontSize: "10",
      textAnchor: "end",
      fill: "var(--mute)"
    }, v)), /*#__PURE__*/React.createElement("line", {
      x1: "40",
      x2: "40",
      y1: "10",
      y2: H - 30,
      stroke: "var(--line)"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "40",
      x2: W - 10,
      y1: H - 30,
      y2: H - 30,
      stroke: "var(--line)"
    }), /*#__PURE__*/React.createElement("text", {
      x: W / 2,
      y: H - 8,
      textAnchor: "middle",
      fontSize: "11",
      fill: "var(--mute)"
    }, "hora real de cruce de 9,0 m (h)"), pts.map((r, i) => /*#__PURE__*/React.createElement("circle", {
      key: i,
      cx: X(r.tc9),
      cy: Y(r.antic9),
      r: "4",
      fill: r.antic9 >= cfg.tmin ? "var(--verde)" : "var(--roja)",
      opacity: ".8"
    })));
  })())), /*#__PURE__*/React.createElement("div", {
    className: "card scroll"
  }, /*#__PURE__*/React.createElement("h2", null, "Matriz de datos experimentales"), /*#__PURE__*/React.createElement("table", null, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Esc."), /*#__PURE__*/React.createElement("th", null, "Sem."), /*#__PURE__*/React.createElement("th", null, "h m\xE1x"), /*#__PURE__*/React.createElement("th", null, "Cruce 9 m"), /*#__PURE__*/React.createElement("th", null, "Alerta N."), /*#__PURE__*/React.createElement("th", null, "Antic."), /*#__PURE__*/React.createElement("th", null, "FP"), /*#__PURE__*/React.createElement("th", null, "Desc."))), /*#__PURE__*/React.createElement("tbody", null, rows.map((r, i) => /*#__PURE__*/React.createElement("tr", {
    key: i
  }, /*#__PURE__*/React.createElement("td", null, r.esc), /*#__PURE__*/React.createElement("td", null, r.seed), /*#__PURE__*/React.createElement("td", null, fmt(r.maxReal)), /*#__PURE__*/React.createElement("td", null, fmtH(r.tc9)), /*#__PURE__*/React.createElement("td", null, fmtH(r.ta9)), /*#__PURE__*/React.createElement("td", null, r.antic9 == null ? "—" : fmt(r.antic9) + " h"), /*#__PURE__*/React.createElement("td", {
    className: r.fpNaranja ? "no" : ""
  }, r.fpNaranja ? "Sí" : "No"), /*#__PURE__*/React.createElement("td", null, r.invalidas))))))));
}

// E1 físico: nodo Arduino Uno + HC-SR04 montado en el puente a H_MONT metros.
// Convierte cada lectura de la simulación en el eco que mediría el sensor.
const H_MONT = 11.0,
  T_AIRE = 30.0,
  C_SON = 331.3 + 0.606 * T_AIRE; // velocidad del sonido a 30 °C
const WOKWI_URL = "https://wokwi.com/projects/479990588756527105";
const SKETCH_URL = "https://github.com/Takashi653/sam-magangue/tree/main/wokwi";
function lecturaSensor(o) {
  if (o == null) return {
    eco: 0,
    d: null,
    hc: null
  }; // sin eco (timeout)
  let d = H_MONT - o;
  if (d < 0.05) d = 0.25 + -d % 1; // pico espurio: eco temprano por basura o aves
  const eco = Math.round(2 * d / C_SON * 1e6);
  return {
    eco,
    d,
    hc: H_MONT - C_SON * eco * 1e-6 / 2
  };
}
function trama(s) {
  const r = lecturaSensor(s.obs);
  return `{"n":${s.i + 1},"eco_us":${r.eco},"T_C":${T_AIRE.toFixed(1)},"c_ms":${C_SON.toFixed(1)},"d_m":${r.d == null ? "null" : r.d.toFixed(3)},"h_m":${s.h == null ? "null" : s.h.toFixed(3)},"dhdt_mh":${s.dhdt.toFixed(3)},"estado":"${s.valido ? "ok" : s.motivo}","alerta":"${NIVELES[s.nivel]}"}`;
}
function Sensor({
  datos,
  paso
}) {
  const [manual, setManual] = useState(false),
    [cm, setCm] = useState(250);
  const s = datos.serie[paso];
  const r = manual ? (() => {
    const d = cm / 100,
      eco = Math.round(2 * d / C_SON * 1e6);
    return {
      eco,
      d,
      hc: H_MONT - d
    };
  })() : lecturaSensor(s.obs);
  const hVis = manual ? r.hc : s.obs != null && s.obs >= 0 && s.obs <= 15 ? s.obs : s.h;
  const lv = manual ? r.hc >= 10 ? "roja" : r.hc >= 9 ? "naranja" : r.hc >= 8 ? "amarilla" : "verde" : NIVELES[s.nivel];
  // escena: y de una cota en metros
  const Y = m => 120 + (H_MONT + 0.4 - m) * 48,
    yAgua = Y(Math.max(5.6, Math.min(hVis ?? 6, 11)));
  const lineas = datos.serie.slice(Math.max(0, paso - 11), paso + 1).map(trama);
  const LED = [["verde", "#2e7d32"], ["amarilla", "#f2b705"], ["naranja", "#e8710a"], ["roja", "#c62828"]];
  return /*#__PURE__*/React.createElement("div", {
    className: "grid g2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("h2", null, "Nodo de medici\xF3n E1 \xB7 Arduino Uno + sensor ultras\xF3nico HC-SR04"), /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 640 420",
    style: {
      width: "100%",
      height: "auto"
    },
    role: "img",
    "aria-label": "Sensor ultras\xF3nico en el puente midiendo la distancia al agua"
  }, /*#__PURE__*/React.createElement("rect", {
    x: "0",
    y: yAgua,
    width: "640",
    height: 420 - yAgua,
    fill: "var(--rio)"
  }), /*#__PURE__*/React.createElement("path", {
    d: `M0 ${yAgua} q20 -5 40 0 t40 0 t40 0 t40 0 t40 0 t40 0 t40 0 t40 0 t40 0 t40 0 t40 0 t40 0 t40 0 t40 0 t40 0 t40 0`,
    fill: "none",
    stroke: "#ffffff99",
    strokeWidth: "2"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "120",
    y: "100",
    width: "420",
    height: "16",
    rx: "3",
    fill: "#8a8f98"
  }), /*#__PURE__*/React.createElement("text", {
    x: "330",
    y: "112",
    fontSize: "11",
    fill: "#fff",
    textAnchor: "middle"
  }, "Puente / muelle \xB7 cota del sensor ", fmt(H_MONT, 2), " m"), /*#__PURE__*/React.createElement("rect", {
    x: "150",
    y: "116",
    width: "12",
    height: "304",
    fill: "#9aa0a8"
  }), [6, 7, 8, 9, 10, 11].map(m => /*#__PURE__*/React.createElement("g", {
    key: m
  }, /*#__PURE__*/React.createElement("line", {
    x1: "40",
    x2: "56",
    y1: Y(m),
    y2: Y(m),
    stroke: "var(--ink)"
  }), /*#__PURE__*/React.createElement("text", {
    x: "34",
    y: Y(m) + 4,
    fontSize: "11",
    textAnchor: "end",
    fill: "var(--ink)"
  }, m, " m"))), /*#__PURE__*/React.createElement("line", {
    x1: "48",
    x2: "48",
    y1: Y(11.2),
    y2: "420",
    stroke: "var(--ink)"
  }), [[8, "var(--amarilla)"], [9, "var(--naranja)"], [10, "var(--roja)"]].map(([m, c]) => /*#__PURE__*/React.createElement("line", {
    key: m,
    x1: "56",
    x2: "640",
    y1: Y(m),
    y2: Y(m),
    stroke: c,
    strokeDasharray: "6 5"
  })), /*#__PURE__*/React.createElement("rect", {
    x: "300",
    y: "118",
    width: "64",
    height: "26",
    rx: "3",
    fill: "#1e5aa8"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "316",
    cy: "136",
    r: "9",
    fill: "#cfd6de",
    stroke: "#333"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "348",
    cy: "136",
    r: "9",
    fill: "#cfd6de",
    stroke: "#333"
  }), /*#__PURE__*/React.createElement("text", {
    x: "332",
    y: "127",
    fontSize: "7",
    fill: "#fff",
    textAnchor: "middle"
  }, "HC-SR04"), r.eco > 0 && /*#__PURE__*/React.createElement("g", {
    className: "ondas"
  }, [0, 1, 2].map(k => /*#__PURE__*/React.createElement("path", {
    key: k,
    d: "M312 150 q20 10 40 0",
    fill: "none",
    stroke: "var(--pri2)",
    strokeWidth: "2",
    style: {
      animationDelay: k * 0.4 + "s"
    }
  }))), /*#__PURE__*/React.createElement("line", {
    x1: "332",
    x2: "332",
    y1: "146",
    y2: yAgua,
    stroke: "var(--pri2)",
    strokeDasharray: "4 4"
  }), r.d != null && /*#__PURE__*/React.createElement("text", {
    x: "340",
    y: (146 + yAgua) / 2,
    fontSize: "12",
    fill: "var(--ink)"
  }, "d = ", fmt(r.d, 3), " m \xB7 eco = ", r.eco.toLocaleString("es-CO"), " \xB5s"), r.eco === 0 && /*#__PURE__*/React.createElement("text", {
    x: "340",
    y: "180",
    fontSize: "12",
    fill: "var(--roja)"
  }, "sin eco (timeout 30 ms)"), /*#__PURE__*/React.createElement("text", {
    x: "180",
    y: yAgua - 6,
    fontSize: "12",
    fill: "var(--ink)",
    fontWeight: "700"
  }, "h = ", fmt(hVis, 2), " m"), /*#__PURE__*/React.createElement("path", {
    d: "M364 128 H440 V80",
    fill: "none",
    stroke: "#e8710a",
    strokeWidth: "2"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M364 136 H452 V80",
    fill: "none",
    stroke: "#7b3fa0",
    strokeWidth: "2"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "420",
    y: "10",
    width: "150",
    height: "70",
    rx: "6",
    fill: "#00878f"
  }), /*#__PURE__*/React.createElement("text", {
    x: "495",
    y: "32",
    fontSize: "12",
    fill: "#fff",
    textAnchor: "middle",
    fontWeight: "700"
  }, "Arduino Uno"), /*#__PURE__*/React.createElement("text", {
    x: "495",
    y: "47",
    fontSize: "9",
    fill: "#fff",
    textAnchor: "middle"
  }, "TRIG D9 \xB7 ECHO D10 \xB7 DHT22 D7"), LED.map(([n, c], k) => /*#__PURE__*/React.createElement("g", {
    key: n
  }, /*#__PURE__*/React.createElement("circle", {
    cx: 444 + k * 34,
    cy: "64",
    r: "7",
    fill: lv === n ? c : "#33404d",
    stroke: "#111"
  }), lv === n && /*#__PURE__*/React.createElement("circle", {
    cx: 444 + k * 34,
    cy: "64",
    r: "12",
    fill: c,
    opacity: ".35"
  }))), /*#__PURE__*/React.createElement("rect", {
    x: "586",
    y: "20",
    width: "34",
    height: "18",
    rx: "3",
    fill: "#222"
  }), /*#__PURE__*/React.createElement("text", {
    x: "603",
    y: "33",
    fontSize: "8",
    fill: "#fff",
    textAnchor: "middle"
  }, "DHT22"), /*#__PURE__*/React.createElement("text", {
    x: "603",
    y: "52",
    fontSize: "10",
    fill: "var(--ink)",
    textAnchor: "middle"
  }, fmt(T_AIRE, 1), " \xB0C")), /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement("label", {
    className: "row"
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: manual,
    onChange: e => setManual(e.target.checked)
  }), " Probar el sensor a mano (como en Wokwi)"), manual && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("input", {
    type: "range",
    min: "2",
    max: "400",
    value: cm,
    onChange: e => setCm(+e.target.value),
    style: {
      flex: 1,
      minWidth: 160
    },
    "aria-label": "Distancia al agua en cm"
  }), /*#__PURE__*/React.createElement("span", null, cm, " cm"))), /*#__PURE__*/React.createElement("p", {
    className: "small"
  }, manual ? "Modo manual: mueva la distancia como en el control del HC-SR04 de Wokwi." : "El sensor sigue la simulación del Panel institucional: avance o reproduzca la serie allí y vea aquí cada lectura.", " Distancia d = c \xB7 t_eco / 2 con c = 331,3 + 0,606\xB7T = ", fmt(C_SON, 1), " m/s; nivel h = ", fmt(H_MONT, 1), " \u2212 d.")), /*#__PURE__*/React.createElement("div", {
    className: "grid",
    style: {
      alignContent: "start"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("h2", null, "Lectura actual ", manual ? "(manual)" : `· t = ${fmt(s.t, 1)} h`), /*#__PURE__*/React.createElement("table", null, /*#__PURE__*/React.createElement("tbody", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Eco (ancho del pulso)"), /*#__PURE__*/React.createElement("td", null, r.eco.toLocaleString("es-CO"), " \xB5s")), /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Temperatura del aire (DHT22)"), /*#__PURE__*/React.createElement("td", null, fmt(T_AIRE, 1), " \xB0C")), /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Velocidad del sonido"), /*#__PURE__*/React.createElement("td", null, fmt(C_SON, 1), " m/s")), /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Distancia al agua d"), /*#__PURE__*/React.createElement("td", null, fmt(r.d, 3), " m")), /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Nivel crudo h = ", fmt(H_MONT, 1), " \u2212 d"), /*#__PURE__*/React.createElement("td", null, fmt(r.hc, 3), " m")), !manual && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Validaci\xF3n P1"), /*#__PURE__*/React.createElement("td", {
    className: s.valido ? "ok" : "no"
  }, s.valido ? "válida" : "descartada: " + s.motivo)), /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Nivel validado"), /*#__PURE__*/React.createElement("td", null, fmt(s.h, 3), " m")), /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "dh/dt (1 h)"), /*#__PURE__*/React.createElement("td", null, fmt(s.dhdt, 3), " m/h"))), /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Sem\xE1foro del nodo"), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    className: "badge b-" + lv
  }, ICO[lv], " ", TXT[lv])))))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("h2", null, "Monitor serial \xB7 115 200 baudios"), /*#__PURE__*/React.createElement("pre", {
    className: "serial"
  }, manual ? `{"eco_us":${r.eco},"T_C":${T_AIRE.toFixed(1)},"d_m":${r.d.toFixed(3)},"h_m":${r.hc.toFixed(3)}}` : lineas.join("\n")), /*#__PURE__*/React.createElement("p", {
    className: "small"
  }, "Cada trama JSON es la que el nodo env\xEDa a la API de ingesta (P1).")), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("h2", null, "Circuito en Wokwi"), /*#__PURE__*/React.createElement("p", {
    className: "small"
  }, "El mismo nodo est\xE1 montado en el simulador de Arduino Wokwi con HC-SR04, DHT22, 4 LEDs y zumbador. El c\xF3digo (sketch.ino) y el diagrama (diagram.json) est\xE1n en el repositorio."), /*#__PURE__*/React.createElement("div", {
    className: "row"
  }, /*#__PURE__*/React.createElement("a", {
    className: "btn",
    href: WOKWI_URL,
    target: "_blank",
    rel: "noopener"
  }, "Abrir en Wokwi"), /*#__PURE__*/React.createElement("a", {
    className: "btn sec",
    href: SKETCH_URL,
    target: "_blank",
    rel: "noopener"
  }, "Ver c\xF3digo")))));
}
function Ecosistema() {
  const filas = [["E1", "Nivel del río h(t)", "Nodo Arduino Uno + HC-SR04 (pestaña Sensor E1 y Wokwi); serie con ruido σ = 1 cm y fallas 2 %", "IDEAM / UNGRD / nodo IoT en el puente"], ["E2", "Perfil del usuario", "10 526 hogares con perfil smartphone, básico o sin celular", "Registro con consentimiento (Ley 1581)"], ["E3", "Reportes ciudadanos", "Formulario de reporte con validación cruzada", "Comunidad de Girardot, Nueva Venecia, Baracoa, Santa Coita"], ["E4", "Parámetros de control", "Pestaña Configuración (umbrales, tmin, tasas)", "Cotas oficiales del IDEAM"], ["P1", "Ingesta y validación", "Rango [0,15] m, salto ≤ 0,5 m / 10 min, última lectura válida", "API REST"], ["P2", "Motor de reglas y pronóstico", "dh/dt en 1 h, tiempo a umbral, histéresis y confirmación", "Reglas explicables (IEEE)"], ["P3", "Base de datos", "Estado en memoria + exportación CSV", "PostgreSQL/PostGIS en la versión final"], ["P4", "Gestor de notificaciones", "Colas a 50 msg/s, acuse en 5 min y 3 reintentos", "Pasarela SMS, servicio push, IVR"], ["P5", "Mapa de riesgo y rutas", "Mapa esquemático SVG con rutas a puntos de encuentro", "Servicio de mapas / PostGIS"], ["S1–S3", "Push, SMS y voz", "Maqueta de celular y síntesis de voz del navegador", "Operadores móviles, altavoces"], ["S5", "Panel institucional", "Pestaña Panel", "Alcaldía de Magangué, UNGRD, CMGRD"], ["R1–R3", "Acuse, validación ciudadana y KPIs", "Reintentos, regla R2 y banco de pruebas", "Recalibración de umbrales"]];
  return /*#__PURE__*/React.createElement("div", {
    className: "grid g2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("h2", null, "El prototipo en su ecosistema real"), /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 560 330",
    width: "100%",
    role: "img",
    "aria-label": "Ecosistema del prototipo"
  }, [["IDEAM / UNGRD\n(datos oficiales)", 20, 20], ["Sensores IoT\n(futuro, LoRa)", 20, 130], ["Comunidad\n(reportes E3)", 20, 240], ["Operador SMS\ny push", 400, 20], ["Altavoces y\nllamada de voz", 400, 130], ["Alcaldía · CMGRD\n(panel S5)", 400, 240]].map(([t, x, y], i) => /*#__PURE__*/React.createElement("g", {
    key: i
  }, /*#__PURE__*/React.createElement("rect", {
    x: x,
    y: y,
    width: "140",
    height: "62",
    rx: "10",
    fill: "var(--bg)",
    stroke: "var(--pri2)"
  }), t.split("\n").map((l, j) => /*#__PURE__*/React.createElement("text", {
    key: j,
    x: x + 70,
    y: y + 27 + j * 15,
    textAnchor: "middle",
    fontSize: "12",
    fill: "var(--ink)"
  }, l)))), /*#__PURE__*/React.createElement("rect", {
    x: "200",
    y: "95",
    width: "160",
    height: "140",
    rx: "14",
    fill: "var(--pri)"
  }), /*#__PURE__*/React.createElement("text", {
    x: "280",
    y: "135",
    textAnchor: "middle",
    fill: "#fff",
    fontWeight: "700",
    fontSize: "14"
  }, "SAM-Magangu\xE9"), ["P1 Validación", "P2 Reglas", "P3 Datos · P4 Envíos", "P5 Mapa y rutas"].map((t, i) => /*#__PURE__*/React.createElement("text", {
    key: i,
    x: "280",
    y: 158 + i * 17,
    textAnchor: "middle",
    fill: "#fff",
    fontSize: "11"
  }, t)), [[160, 51, 200, 120], [160, 161, 200, 165], [160, 271, 200, 210], [360, 120, 400, 51], [360, 165, 400, 161], [360, 210, 400, 271]].map(([a, b, c, d], i) => /*#__PURE__*/React.createElement("line", {
    key: i,
    x1: a,
    y1: b,
    x2: c,
    y2: d,
    stroke: "var(--mute)",
    strokeWidth: "1.5",
    markerEnd: "url(#ar)"
  })), /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("marker", {
    id: "ar",
    viewBox: "0 0 10 10",
    refX: "9",
    refY: "5",
    markerWidth: "6",
    markerHeight: "6",
    orient: "auto"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M0,0L10,5L0,10z",
    fill: "var(--mute)"
  }))), /*#__PURE__*/React.createElement("text", {
    x: "280",
    y: "320",
    textAnchor: "middle",
    fontSize: "11",
    fill: "var(--mute)"
  }, "Restricciones: conectividad limitada, Habeas Data, temporada de lluvias, gama b\xE1sica"))), /*#__PURE__*/React.createElement("div", {
    className: "card scroll",
    style: {
      maxHeight: 420
    }
  }, /*#__PURE__*/React.createElement("h2", null, "Correspondencia dise\xF1o (Etapa 3) \u2192 prototipo"), /*#__PURE__*/React.createElement("table", null, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Bloque"), /*#__PURE__*/React.createElement("th", null, "Elemento"), /*#__PURE__*/React.createElement("th", null, "Implementaci\xF3n en el prototipo"), /*#__PURE__*/React.createElement("th", null, "Actor/sistema real"))), /*#__PURE__*/React.createElement("tbody", null, filas.map(f => /*#__PURE__*/React.createElement("tr", {
    key: f[0]
  }, f.map((c, i) => /*#__PURE__*/React.createElement("td", {
    key: i
  }, i === 0 ? /*#__PURE__*/React.createElement("b", null, c) : c))))))));
}
function Config({
  cfg,
  setCfg
}) {
  const F = ({
    k,
    label,
    step = 0.01
  }) => /*#__PURE__*/React.createElement("label", {
    style: {
      display: "block",
      margin: "6px 0"
    }
  }, label, " ", /*#__PURE__*/React.createElement("input", {
    type: "number",
    step: step,
    value: cfg[k],
    onChange: e => setCfg({
      ...cfg,
      [k]: +e.target.value
    }),
    style: {
      width: 90
    }
  }));
  return /*#__PURE__*/React.createElement("div", {
    className: "grid g3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("h2", null, "E4 \xB7 Umbrales y reglas"), /*#__PURE__*/React.createElement(F, {
    k: "hAm",
    label: "Umbral amarillo (m)"
  }), /*#__PURE__*/React.createElement(F, {
    k: "hNa",
    label: "Umbral naranja (m)"
  }), /*#__PURE__*/React.createElement(F, {
    k: "hRo",
    label: "Umbral rojo (m)"
  }), /*#__PURE__*/React.createElement(F, {
    k: "tmin",
    label: "Anticipaci\xF3n m\xEDnima tmin (h)",
    step: 0.5
  }), /*#__PURE__*/React.createElement(F, {
    k: "confirm",
    label: "Lecturas de confirmaci\xF3n",
    step: 1
  }), /*#__PURE__*/React.createElement(F, {
    k: "histeresis",
    label: "Hist\xE9resis de bajada (m)"
  })), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("h2", null, "P4 \xB7 Notificaciones"), /*#__PURE__*/React.createElement(F, {
    k: "rate",
    label: "Tasa por cola (msg/s)",
    step: 5
  }), /*#__PURE__*/React.createElement("label", null, "Colas ", /*#__PURE__*/React.createElement("select", {
    value: cfg.colas,
    onChange: e => setCfg({
      ...cfg,
      colas: e.target.value
    })
  }, /*#__PURE__*/React.createElement("option", {
    value: "paralelo"
  }, "Una por canal"), /*#__PURE__*/React.createElement("option", {
    value: "compartida"
  }, "Una compartida"))), /*#__PURE__*/React.createElement(F, {
    k: "pPush",
    label: "p entrega push"
  }), /*#__PURE__*/React.createElement(F, {
    k: "pSms",
    label: "p entrega SMS"
  }), /*#__PURE__*/React.createElement(F, {
    k: "pVoz",
    label: "p entrega voz"
  }), /*#__PURE__*/React.createElement(F, {
    k: "retries",
    label: "Reintentos",
    step: 1
  })), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("h2", null, "E1 \xB7 Sensor simulado"), /*#__PURE__*/React.createElement(F, {
    k: "sigma",
    label: "Ruido \u03C3 (m)",
    step: 0.005
  }), /*#__PURE__*/React.createElement(F, {
    k: "pFalla",
    label: "Prob. de falla por lectura",
    step: 0.005
  }), /*#__PURE__*/React.createElement("button", {
    className: "btn sec",
    onClick: () => setCfg(DEF_CFG)
  }, "Restaurar valores de la Etapa 3")));
}
function App() {
  const Q = new URLSearchParams(location.search);
  const CAP = Q.get("captura") === "1";
  const [user, setUser] = useState(() => {
    if (CAP) {
      if (Q.get("rol") === "ciudadano") return {
        usuario: "ejemplo",
        nombre: "Ciudadana de ejemplo",
        rol: "Ciudadano",
        barrio: "nv",
        canal: "sms"
      };
      const {
        clave,
        ...s
      } = DEMO;
      return s;
    }
    return leerSesion();
  });
  const [logs, setLogs] = useState([]);
  const prevNivel = useRef(0);
  useEffect(() => {
    if (CAP && Q.get("paso")) setPaso(+Q.get("paso"));
    if (CAP && Q.get("esc")) setEsc(Q.get("esc"));
    if (CAP && Q.get("auto")) setTimeout(() => {
      document.querySelectorAll("button").forEach(b => {
        if (/Ejecutar pruebas|Simular difusi/.test(b.textContent)) b.click();
      });
    }, 300);
  }, []);
  const [tab, setTab] = useState(Q.get("tab") || "panel"),
    [cfg, setCfg] = useState(DEF_CFG),
    [esc, setEsc] = useState("creciente"),
    [seed, setSeed] = useState(7);
  const [paso, setPaso] = useState(0),
    [play, setPlay] = useState(false),
    [vel, setVel] = useState(120),
    [reportes, setReportes] = useState([]);
  const datos = useMemo(() => {
    const g = generarSerie(esc, cfg, seed, 0);
    return {
      real: g.real,
      serie: procesar(g.obs, cfg)
    };
  }, [esc, cfg, seed]);
  useEffect(() => {
    if (!play) return;
    const id = setInterval(() => setPaso(p => {
      if (p >= N_STEPS - 1) {
        setPlay(false);
        return p;
      }
      return p + 1;
    }), vel);
    return () => clearInterval(id);
  }, [play, vel]);
  // Bitácora en vivo: P1 (lecturas descartadas), P2 (cambio de alerta) y P4 (difusión automática)
  useEffect(() => {
    if (paso === 0) {
      setLogs([{
        t: 0,
        tipo: "info",
        bloque: "E1",
        txt: `Estación conectada. Escenario: ${ESCENARIOS[esc].nombre}.`
      }]);
      prevNivel.current = datos.serie[0].nivel;
      return;
    }
    const s = datos.serie[paso],
      nuevos = [];
    if (!s.valido) nuevos.push({
      t: s.t,
      tipo: "falla",
      bloque: "P1",
      txt: `Lectura descartada (${s.motivo}); se conserva ${fmt(s.h)} m.`
    });
    if (s.nivel !== prevNivel.current) {
      const sube = s.nivel > prevNivel.current;
      const lv = NIVELES[s.nivel];
      nuevos.push({
        t: s.t,
        tipo: "alerta",
        bloque: "P2",
        txt: `${sube ? "Sube" : "Baja"} a ${TXT[lv].toUpperCase()} · h = ${fmt(s.h)} m · dh/dt = ${fmt(s.dhdt, 3)} m/h.`
      });
      if (sube) {
        const r = simularDifusion(cfg, 1000 + paso, lv);
        nuevos.push({
          t: s.t,
          tipo: "envio",
          bloque: "P4",
          txt: `${r.msgs.toLocaleString("es-CO")} mensajes en ${fmt(r.difusion, 0)} s · entrega ${fmt(r.entregaFinal * 100, 2)} % (push ${r.porCanal.push}, SMS ${r.porCanal.sms}, voz ${r.porCanal.voz}).`
        });
        if (s.nivel >= 2) nuevos.push({
          t: s.t,
          tipo: "info",
          bloque: "P5",
          txt: "Rutas de evacuación publicadas para los 4 barrios."
        });
        if (s.nivel === 3) nuevos.push({
          t: s.t,
          tipo: "alerta",
          bloque: "S5",
          txt: "Escalado a Alcaldía, UNGRD y CMGRD para decisión de evacuación."
        });
      }
      prevNivel.current = s.nivel;
    }
    if (nuevos.length) setLogs(l => [...l, ...nuevos]);
  }, [paso, datos]);
  if (!user) return /*#__PURE__*/React.createElement(Login, {
    onOk: u => {
      guardarSesion(u);
      setUser(u);
    }
  });
  const T = [["panel", "Panel institucional"], ["sensor", "Sensor E1 (Arduino)"], ["notif", "Notificaciones"], ["rep", "Reportes ciudadanos"], ["exp", "Experimentos y KPIs"], ["eco", "Ecosistema"], ["cfg", "Configuración"]];
  const lv = NIVELES[datos.serie[paso].nivel];
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "top"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h1", null, "SAM-Magangu\xE9"), /*#__PURE__*/React.createElement("div", {
    className: "sub"
  }, "Sistema de Alerta Multicanal \xB7 r\xEDo Magdalena \xB7 prototipo de baja fidelidad")), /*#__PURE__*/React.createElement("span", {
    className: "badge b-" + lv,
    style: {
      marginLeft: "auto"
    }
  }, ICO[lv], " ", TXT[lv]), /*#__PURE__*/React.createElement("span", {
    className: "sub"
  }, "\uD83D\uDC64 ", user.nombre, " \xB7 ", user.rol), /*#__PURE__*/React.createElement("button", {
    className: "btn sec",
    style: {
      color: "#fff",
      borderColor: "#ffffff66"
    },
    onClick: () => {
      guardarSesion(null);
      location.href = "index.html";
    }
  }, "Cerrar sesi\xF3n")), /*#__PURE__*/React.createElement("nav", {
    className: "tabs"
  }, T.map(([k, t]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    className: "tab" + (tab === k ? " on" : ""),
    onClick: () => setTab(k)
  }, t))), /*#__PURE__*/React.createElement("main", null, tab === "panel" && /*#__PURE__*/React.createElement(Panel, {
    cfg,
    esc,
    setEsc,
    seed,
    setSeed,
    paso,
    setPaso,
    play,
    setPlay,
    vel,
    setVel,
    datos,
    reportes,
    logs,
    user
  }), tab === "sensor" && /*#__PURE__*/React.createElement(Sensor, {
    datos: datos,
    paso: paso
  }), tab === "notif" && /*#__PURE__*/React.createElement(Notificaciones, {
    cfg: cfg,
    datos: datos,
    paso: paso,
    user: user.usuario
  }), tab === "rep" && /*#__PURE__*/React.createElement(Reportes, {
    reportes,
    setReportes,
    datos,
    paso
  }), tab === "exp" && /*#__PURE__*/React.createElement(Experimentos, {
    cfg: cfg
  }), tab === "eco" && /*#__PURE__*/React.createElement(Ecosistema, null), tab === "cfg" && /*#__PURE__*/React.createElement(Config, {
    cfg: cfg,
    setCfg: setCfg
  }), /*#__PURE__*/React.createElement("p", {
    className: "small",
    style: {
      textAlign: "center",
      marginTop: 20
    }
  }, "Proyecto de Ingenier\xEDa I \xB7 UNAD \xB7 Grupo 62 \xB7 William Enrique Paba Ruenes \xB7 Datos simulados con fines acad\xE9micos")));
}
window.__SAM = {
  evaluarCorrida,
  simularDifusion,
  procesar,
  generarSerie,
  DEF_CFG,
  ESCENARIOS
};
{
  const t = new URLSearchParams(location.search).get("tema");
  if (t) document.documentElement.setAttribute("data-theme", t);
}
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(App, null));
